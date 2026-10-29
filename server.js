require('dotenv').config();
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createAppointmentStore } = require("./backend/appointment-store");
const { createPatientStore, normalizePhone } = require("./backend/patient-store");
const { createSessionManager, passwordMatches } = require("./backend/auth");
const { createPushNotifier } = require("./backend/push-notifications");
const webPush = require("web-push");

const root = __dirname;
const dataFile = process.env.APPOINTMENTS_FILE || path.join(root, "data", "appointments.json");
const patientsFile = process.env.PATIENTS_FILE || path.join(root, "data", "patients.json");
const pushSubscriptionsFile = process.env.PUSH_SUBSCRIPTIONS_FILE
  || path.join(root, "data", "push-subscriptions.json");
const appointmentStore = createAppointmentStore(dataFile);
const patientStore = createPatientStore(patientsFile);
const pushNotifier = createPushNotifier({
  dataFile: pushSubscriptionsFile,
  webPush,
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT
});
const port = Number(process.env.PORT || 3000);
const host = "127.0.0.1";
const sessionDuration = 8 * 60 * 60 * 1000;
const staffSessions = createSessionManager(sessionDuration);
const eventClients = new Map();
const patientPinAttempts = new Map();
const pinAttemptLimit = 5;
const ipPinAttemptLimit = 20;
const pinAttemptWindow = 15 * 60 * 1000;

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

async function readRequestJson(request) {
  const chunks = [];
  let bodyLength = 0;
  for await (const chunk of request) {
    bodyLength += chunk.length;
    if (bodyLength > 16_384) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function requireStaff(request, response) {
  if (staffSessions.get(request)) return true;
  sendJson(response, 401, { error: "Staff sign-in required." });
  return false;
}

function requireSameOrigin(request, response) {
  const origin = request.headers.origin;
  const hostOrigin = request.headers.host;
  if (!origin || origin === `http://${hostOrigin}` || origin === `https://${hostOrigin}`) return true;
  sendJson(response, 403, { error: "Cross-origin request blocked." });
  return false;
}

function broadcastEvent(payload) {
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [response, heartbeat] of eventClients) {
    if (response.destroyed || response.writableEnded) {
      clearInterval(heartbeat);
      eventClients.delete(response);
      continue;
    }
    try {
      response.write(event);
    } catch (error) {
      console.error("Could not send a live appointment update:", error.message);
      clearInterval(heartbeat);
      eventClients.delete(response);
      response.destroy();
    }
  }
}

function isPinRateLimited(ipKey, patientKey) {
  const now = Date.now();
  for (const [key, attempt] of patientPinAttempts) {
    if (attempt.expiresAt <= now) patientPinAttempts.delete(key);
  }
  return (patientPinAttempts.get(ipKey)?.count || 0) >= ipPinAttemptLimit
    || (patientPinAttempts.get(patientKey)?.count || 0) >= pinAttemptLimit;
}

function recordFailedPinAttempt(ipKey, patientKey) {
  const expiresAt = Date.now() + pinAttemptWindow;
  for (const key of [ipKey, patientKey]) {
    const attempt = patientPinAttempts.get(key);
    patientPinAttempts.set(key, {
      count: attempt?.expiresAt > Date.now() ? attempt.count + 1 : 1,
      expiresAt: attempt?.expiresAt > Date.now() ? attempt.expiresAt : expiresAt
    });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    if (!requireSameOrigin(request, response)) return;
    if (!process.env.STAFF_PASSWORD) {
      sendJson(response, 503, { error: "Staff sign-in is not configured. Set the STAFF_PASSWORD environment variable and restart the server." });
      return;
    }
    const input = await readRequestJson(request);
    const username = input && typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
    const password = input && typeof input.password === "string" ? input.password : "";
    if (!["drnikhil", "drshubhangi", "staff_admin"].includes(username)
      || !passwordMatches(password, process.env.STAFF_PASSWORD)) {
      sendJson(response, 401, { error: "Invalid staff ID or password." });
      return;
    }
    const session = staffSessions.create();
    const secureCookie = request.headers.origin === `https://${request.headers.host}` ? "; Secure" : "";
    sendJson(response, 200, { ok: true, username }, {
      "Set-Cookie": `clinic_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secureCookie}`
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    if (!requireSameOrigin(request, response)) return;
    staffSessions.revoke(request);
    const secureCookie = request.headers.origin === `https://${request.headers.host}` ? "; Secure" : "";
    sendJson(response, 200, { ok: true }, {
      "Set-Cookie": `clinic_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/appointments") {
    if (!requireSameOrigin(request, response)) return;
    const input = await readRequestJson(request);
    if (input && input.emergency === true && !requireStaff(request, response)) return;
    const appointment = await appointmentStore.add(input);
    broadcastEvent({ type: "appointment", appointment });
    pushNotifier.notifyNewAppointment().catch(error => {
      console.error("Could not deliver browser push notifications:", error.message);
    });
    sendJson(response, 201, { appointment });
    return;
  }

  if (url.pathname === "/api/push/config" && request.method === "GET") {
    if (!requireStaff(request, response)) return;
    sendJson(response, 200, {
      configured: pushNotifier.configured,
      publicKey: pushNotifier.publicKey
    });
    return;
  }

  if (url.pathname === "/api/push/subscriptions" && request.method === "POST") {
    if (!requireSameOrigin(request, response)) return;
    if (!requireStaff(request, response)) return;
    if (!pushNotifier.configured) {
      sendJson(response, 503, { error: "Browser push notifications are not configured on this server." });
      return;
    }
    await pushNotifier.subscribe(await readRequestJson(request));
    sendJson(response, 201, { ok: true });
    return;
  }

  if (url.pathname === "/api/push/subscriptions" && request.method === "DELETE") {
    if (!requireSameOrigin(request, response)) return;
    if (!requireStaff(request, response)) return;
    const input = await readRequestJson(request);
    await pushNotifier.unsubscribe(input && input.endpoint);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/appointment-status") {
    if (!requireSameOrigin(request, response)) return;
    const input = await readRequestJson(request);
    const phone = input && typeof input.phone === "string" ? input.phone : "";
    const token = input && typeof input.token === "string" ? input.token.trim() : "";
    const date = input && typeof input.date === "string" ? input.date : "";
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.length < 7 || normalizedPhone.length > 15
      || !/^Token #\d{2,}$/.test(token)
      || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(response, 400, { error: "Enter the phone number, appointment date, and token from your booking confirmation." });
      return;
    }
    const appointments = await appointmentStore.list();
    const appointment = appointments.find(item =>
      item.phone && normalizePhone(item.phone) === normalizedPhone
      && item.token === token && item.date === date);
    if (!appointment) {
      sendJson(response, 404, { error: "No appointment matched those details. Check the phone number, date, and token." });
      return;
    }
    sendJson(response, 200, {
      token: appointment.token,
      date: appointment.date,
      slot: appointment.slot,
      status: appointment.status
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/patient/history") {
    if (!requireSameOrigin(request, response)) return;
    const input = await readRequestJson(request);
    const patient = input && typeof input.patient === "string" ? input.patient : "";
    const pin = input && typeof input.pin === "string" ? input.pin : "";
    if (!patient.trim() || patient.trim().length > 100 || !/^\d{8}$/.test(pin)) {
      sendJson(response, 401, { error: "The patient name or PIN is incorrect." });
      return;
    }
    const address = request.socket.remoteAddress || "unknown";
    const ipKey = `ip:${address}`;
    const patientKey = `patient:${address}:${patient.trim().normalize("NFKC").toLocaleLowerCase("en")}`;
    if (isPinRateLimited(ipKey, patientKey)) {
      sendJson(response, 429, { error: "Too many incorrect PIN attempts. Try again in 15 minutes." });
      return;
    }
    const history = await patientStore.verifyPin(patient, pin);
    if (!history) {
      recordFailedPinAttempt(ipKey, patientKey);
      sendJson(response, 401, { error: "The patient name or PIN is incorrect." });
      return;
    }
    patientPinAttempts.delete(ipKey);
    patientPinAttempts.delete(patientKey);
    sendJson(response, 200, history);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/patients/history") {
    if (!requireStaff(request, response)) return;
    const patient = url.searchParams.get("name") || "";
    if (!patient.trim() || patient.trim().length > 100) {
      sendJson(response, 400, { error: "Enter the patient name for history lookup." });
      return;
    }
    const patients = await patientStore.searchByName(patient);
    sendJson(response, 200, { patients });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/patients/records") {
    if (!requireSameOrigin(request, response)) return;
    if (!requireStaff(request, response)) return;
    const input = await readRequestJson(request);
    const appointments = await appointmentStore.list();
    const appointment = appointments.find(item => item.id === input?.appointmentId);
    const normalizePatientName = value => typeof value === "string"
      ? value.normalize("NFKC").trim().toLocaleLowerCase("en")
      : "";
    if (!appointment || appointment.status !== "Completed"
      || normalizePhone(appointment.phone) !== normalizePhone(input?.phone || "")
      || normalizePatientName(appointment.patient) !== normalizePatientName(input?.patient)) {
      sendJson(response, 400, { error: "Visit records require a completed appointment with the same patient name and phone number." });
      return;
    }
    const result = await patientStore.addVisit(input);
    broadcastEvent({ type: "patient-history", phone: normalizePhone(input.phone) });
    sendJson(response, 201, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    if (!requireStaff(request, response)) return;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff"
    });
    response.write("retry: 3000\n\n");
    const heartbeat = setInterval(() => {
      if (!staffSessions.get(request)) {
        response.write("event: auth-expired\ndata: {}\n\n");
        response.end();
        clearInterval(heartbeat);
        eventClients.delete(response);
        return;
      }
      if (!response.destroyed && !response.writableEnded) response.write(": keep-alive\n\n");
    }, 20_000);
    eventClients.set(response, heartbeat);
    response.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(response);
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/appointments") {
    if (!requireStaff(request, response)) return;
    sendJson(response, 200, { appointments: await appointmentStore.list() });
    return;
  }

  const appointmentMatch = url.pathname.match(/^\/api\/appointments\/([a-f0-9-]+)$/i);
  if (request.method === "PATCH" && appointmentMatch) {
    if (!requireSameOrigin(request, response)) return;
    if (!requireStaff(request, response)) return;
    const input = await readRequestJson(request);
    if (!input || !["Waiting", "In Consultation", "Completed"].includes(input.status)) {
      sendJson(response, 400, { error: "Select a valid appointment status." });
      return;
    }
    const appointment = await appointmentStore.updateStatus(appointmentMatch[1], input.status);
    if (!appointment) {
      sendJson(response, 404, { error: "Appointment not found." });
      return;
    }
    broadcastEvent({ type: "appointment", appointment });
    sendJson(response, 200, { appointment });
    return;
  }

  const staticFiles = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/service-worker.js": ["service-worker.js", "application/javascript; charset=utf-8"],
    "/image%203.jpeg": ["image 3.jpeg", "image/jpeg"],
    "/image%207.jpeg": ["image 7.jpeg", "image/jpeg"],
    "/image%208.jpeg": ["image 8.jpeg", "image/jpeg"]
  };
  const staticFile = staticFiles[url.pathname];
  if (request.method === "GET" && staticFile) {
    const content = await fs.readFile(path.join(root, staticFile[0]));
    response.writeHead(200, {
      "Content-Type": staticFile[1],
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    response.end(content);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function start() {
  await appointmentStore.initialize();
  await patientStore.initialize();
  await pushNotifier.initialize();

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error("Request failed:", error.message);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : "The request could not be completed."
        });
      } else {
        response.destroy(error);
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`Kalpana Hospital server listening at http://${host}:${port}`);
    if (!process.env.STAFF_PASSWORD) {
      console.warn("Staff sign-in is disabled until STAFF_PASSWORD is configured.");
    }
    if (!pushNotifier.configured) {
      console.warn("Browser push notifications are disabled until VAPID credentials are configured.");
    }
  });
}

start().catch(error => {
  console.error("Could not start the hospital server:", error.message);
  process.exitCode = 1;
});
