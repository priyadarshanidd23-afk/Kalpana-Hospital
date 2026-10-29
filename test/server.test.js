const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

const root = path.join(__dirname, "..");

async function getOpenPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not become ready.");
}

function createEventReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function readWithTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(new Error("Timed out waiting for a real-time server update."));
      }, timeoutMs);
      reader.read().then(resolve, reject).finally(() => clearTimeout(timeout));
    });
  }

  return async function nextMessage(timeoutMs = 3000) {
    while (true) {
      const messages = buffer.split("\n\n");
      buffer = messages.pop();
      for (const message of messages) {
        const dataLine = message.split("\n").find(line => line.startsWith("data: "));
        if (dataLine) return JSON.parse(dataLine.slice(6));
      }

      const result = await readWithTimeout(timeoutMs);
      if (result.done) throw new Error("Real-time update stream closed unexpectedly.");
      buffer += decoder.decode(result.value, { stream: true });
    }
  };
}

test("local website serves booking, staff queue, persistence, and live updates", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kalpana-server-test-"));
  const dataFile = path.join(directory, "appointments.json");
  const port = await getOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = "test-only-strong-password";
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APPOINTMENTS_FILE: dataFile,
      PATIENTS_FILE: path.join(directory, "patients.json"),
      PUSH_SUBSCRIPTIONS_FILE: path.join(directory, "push-subscriptions.json"),
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
      VAPID_SUBJECT: "",
      STAFF_PASSWORD: password
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { serverOutput += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { serverOutput += chunk; });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  await waitForServer(child, baseUrl).catch(error => {
    throw new Error(`${error.message}\n${serverOutput}`);
  });

  const postAppointment = (appointment, cookie, origin = baseUrl) => fetch(`${baseUrl}/api/appointments`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(appointment)
  });
  const appointment = (patient, slot = "10:30 AM") => ({
    patient,
    phone: "+91 9876543210",
    doctor: "Dr. Nikhil H. Mahanubhav",
    treatment: "Root Canal (RCT)",
    slot,
    date: "2024-08-01",
    reason: "Test booking"
  });

  assert.equal((await (await fetch(`${baseUrl}/api/health`)).json()).ok, true);
  assert.equal((await fetch(`${baseUrl}/api/push/config`)).status, 401);
  const serviceWorker = await fetch(`${baseUrl}/service-worker.js`);
  assert.equal(serviceWorker.status, 200);
  assert.match(serviceWorker.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(`${baseUrl}/api/appointments`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/patients/history?name=Patient`)).status, 401);
  assert.equal(
    (await postAppointment(appointment("Cross-origin"), undefined, "https://attacker.example")).status,
    403
  );
  const bookedResponse = await postAppointment(appointment("Patient One"));
  assert.equal(bookedResponse.status, 201);
  const bookedAppointment = (await bookedResponse.json()).appointment;
  const lookupAppointmentStatus = (details, origin = baseUrl) => fetch(`${baseUrl}/api/appointment-status`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(details)
  });
  const trackingDetails = {
    phone: bookedAppointment.phone,
    date: bookedAppointment.date,
    token: bookedAppointment.token
  };
  const waitingStatusResponse = await lookupAppointmentStatus(trackingDetails);
  assert.equal(waitingStatusResponse.status, 200);
  assert.deepEqual(await waitingStatusResponse.json(), {
    token: bookedAppointment.token,
    date: bookedAppointment.date,
    slot: bookedAppointment.slot,
    status: "Waiting"
  });
  assert.equal((await lookupAppointmentStatus({ ...trackingDetails, phone: "+91 9000000000" })).status, 404);
  assert.equal((await lookupAppointmentStatus(trackingDetails, "https://attacker.example")).status, 403);
  const noPinHistory = await fetch(`${baseUrl}/api/patient/history`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ patient: "Patient One", pin: "12345678" })
  });
  assert.equal(noPinHistory.status, 401);
  assert.equal((await postAppointment(appointment("Conflicting Booking"))).status, 409);
  assert.equal(
    (await postAppointment({ ...appointment("Invalid Clinician", "11:15 AM"), doctor: "Unknown" })).status,
    400
  );
  assert.equal(
    (await postAppointment({
      ...appointment("Unauthorized Emergency", "Immediate Priority"),
      phone: "",
      doctor: "Dr. Nikhil & Dr. Shubhangi",
      emergency: true
    })).status,
    401
  );

  const failedLogin = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "drnikhil", password: "wrong-password" })
  });
  assert.equal(failedLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "drnikhil", password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const pushConfigResponse = await fetch(`${baseUrl}/api/push/config`, {
    headers: { Cookie: cookie }
  });
  assert.equal(pushConfigResponse.status, 200);
  assert.deepEqual(await pushConfigResponse.json(), { configured: false, publicKey: null });
  assert.equal((await fetch(`${baseUrl}/api/push/subscriptions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({})
  })).status, 503);
  assert.equal((await fetch(`${baseUrl}/api/push/subscriptions`, {
    method: "POST",
    headers: {
      Origin: baseUrl.replace("http://", "https://"),
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({})
  })).status, 503);
  const privateQueue = await fetch(`${baseUrl}/api/appointments`, { headers: { Cookie: cookie } });
  assert.equal((await privateQueue.json()).appointments.length, 1);
  const unauthorizedRecord = await fetch(`${baseUrl}/api/patients/records`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: "clinic_session=invalid"
    },
    body: JSON.stringify({})
  });
  assert.equal(unauthorizedRecord.status, 401);

  const eventController = new AbortController();
  const stream = await fetch(`${baseUrl}/api/events`, {
    headers: { Cookie: cookie },
    signal: eventController.signal
  });
  assert.equal(stream.status, 200);
  const nextMessage = createEventReader(stream);
  const firstEvent = nextMessage();
  assert.equal((await postAppointment(appointment("Live Patient", "11:00 AM"))).status, 201);
  const event = await firstEvent;
  assert.equal(event.appointment.patient, "Live Patient");

  const appointments = (await (await fetch(`${baseUrl}/api/appointments`, {
    headers: { Cookie: cookie }
  })).json()).appointments;
  const uncompletedVisit = await fetch(`${baseUrl}/api/patients/records`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({
      appointmentId: appointments[0].id,
      patient: appointments[0].patient,
      phone: appointments[0].phone,
      date: appointments[0].date,
      doctor: appointments[0].doctor,
      treatment: appointments[0].treatment,
      notes: "",
      followUp: ""
    })
  });
  assert.equal(uncompletedVisit.status, 400);
  const statusEvent = nextMessage();
  const statusUpdate = await fetch(`${baseUrl}/api/appointments/${appointments[0].id}`, {
    method: "PATCH",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({ status: "In Consultation" })
  });
  assert.equal(statusUpdate.status, 200);
  assert.equal((await statusEvent).appointment.status, "In Consultation");
  const calledStatusResponse = await lookupAppointmentStatus(trackingDetails);
  assert.equal((await calledStatusResponse.json()).status, "In Consultation");
  const completionEvent = nextMessage();
  const completionUpdate = await fetch(`${baseUrl}/api/appointments/${appointments[0].id}`, {
    method: "PATCH",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({ status: "Completed" })
  });
  assert.equal(completionUpdate.status, 200);
  assert.equal((await completionEvent).appointment.status, "Completed");
  const completedStatusResponse = await lookupAppointmentStatus(trackingDetails);
  assert.equal((await completedStatusResponse.json()).status, "Completed");
  const mismatchedPatient = await fetch(`${baseUrl}/api/patients/records`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({
      appointmentId: appointments[0].id,
      patient: "Different Patient",
      phone: appointments[0].phone,
      date: appointments[0].date,
      doctor: appointments[0].doctor,
      treatment: appointments[0].treatment,
      notes: "",
      followUp: ""
    })
  });
  assert.equal(mismatchedPatient.status, 400);
  const visitEvent = nextMessage();
  const recordResponse = await fetch(`${baseUrl}/api/patients/records`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({
      appointmentId: appointments[0].id,
      patient: appointments[0].patient,
      phone: appointments[0].phone,
      date: appointments[0].date,
      doctor: appointments[0].doctor,
      treatment: appointments[0].treatment,
      notes: "Completed at this clinic.",
      followUp: "Review in one week."
    })
  });
  assert.equal(recordResponse.status, 201);
  const record = await recordResponse.json();
  assert.match(record.issuedPin, /^\d{8}$/);
  assert.equal((await visitEvent).type, "patient-history");
  const staffHistoryResponse = await fetch(`${baseUrl}/api/patients/history?name=${encodeURIComponent(appointments[0].patient)}`, {
    headers: { Cookie: cookie }
  });
  assert.equal(staffHistoryResponse.status, 200);
  const staffHistory = await staffHistoryResponse.json();
  assert.equal(staffHistory.patients.length, 1);
  assert.equal(staffHistory.patients[0].visits.length, 1);
  const duplicateVisit = await fetch(`${baseUrl}/api/patients/records`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({
      appointmentId: appointments[0].id,
      patient: appointments[0].patient,
      phone: appointments[0].phone,
      date: appointments[0].date,
      doctor: appointments[0].doctor,
      treatment: appointments[0].treatment,
      notes: "Duplicate",
      followUp: ""
    })
  });
  assert.equal(duplicateVisit.status, 409);

  const patientLookup = async (patient, pin) => fetch(`${baseUrl}/api/patient/history`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ patient, pin })
  });
  const patientHistoryResponse = await patientLookup(appointments[0].patient, record.issuedPin);
  assert.equal(patientHistoryResponse.status, 200);
  const patientHistory = await patientHistoryResponse.json();
  assert.equal(patientHistory.patient, appointments[0].patient);
  assert.equal(patientHistory.visits.length, 1);
  assert.equal(patientHistory.visits[0].notes, "Completed at this clinic.");
  assert.equal((await patientLookup("Unknown Patient", record.issuedPin)).status, 401);
  assert.equal((await patientLookup(appointments[0].patient, "00000000")).status, 401);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await patientLookup(appointments[0].patient, "00000000")).status, 401);
  }
  assert.equal((await patientLookup(appointments[0].patient, "00000000")).status, 429);
  eventController.abort();

  const persisted = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].status, "Completed");
  const patientData = JSON.parse(await fs.readFile(path.join(directory, "patients.json"), "utf8"));
  assert.equal(patientData.length, 1);
  assert.equal(patientData[0].pinHash.includes(record.issuedPin), false);

  for (const asset of ["image%203.jpeg", "image%207.jpeg", "image%208.jpeg"]) {
    const response = await fetch(`${baseUrl}/${asset}`);
    assert.equal(response.status, 200, `${asset} should be served by the local site`);
    assert.match(response.headers.get("content-type"), /image\/jpeg/);
  }

  await fetch(`${baseUrl}/api/logout`, {
    method: "POST",
    headers: { Origin: baseUrl, Cookie: cookie }
  });
  assert.equal((await fetch(`${baseUrl}/api/appointments`, {
    headers: { Cookie: cookie }
  })).status, 401);
});
