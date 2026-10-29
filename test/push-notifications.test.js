const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPushNotifier } = require("../backend/push-notifications");

test("push subscriptions persist and new-booking alerts omit patient details", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kalpana-push-test-"));
  const dataFile = path.join(directory, "subscriptions.json");
  const sent = [];
  const errors = [];
  const webPush = {
    setVapidDetails() {},
    async sendNotification(subscription, payload, options) {
      if (subscription.endpoint.endsWith("/expired")) {
        const error = new Error("Subscription expired.");
        error.statusCode = 410;
        throw error;
      }
      sent.push({ subscription, payload: JSON.parse(payload), options });
    }
  };
  const notifier = createPushNotifier({
    dataFile,
    webPush,
    publicKey: "test-public-key",
    privateKey: "test-private-key",
    subject: "mailto:clinic@example.com",
    logger: { error: (...args) => errors.push(args) }
  });

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await notifier.initialize();
  const subscription = endpoint => ({
    endpoint: `https://push.example/${endpoint}`,
    keys: { p256dh: "public-key", auth: "auth-key" }
  });
  await notifier.subscribe(subscription("active"));
  await notifier.subscribe(subscription("expired"));
  await notifier.notifyNewAppointment({
    patient: "Private Patient",
    phone: "1234567890",
    treatment: "Private treatment"
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, {
    title: "New appointment request",
    body: "A new appointment was booked. Sign in to view the details.",
    url: "/?staff=1"
  });
  assert.deepEqual(sent[0].options, { TTL: 60, urgency: "high" });
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, "utf8")), [subscription("active")]);
});

test("push subscriptions reject invalid endpoints and incomplete VAPID configuration", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kalpana-push-test-"));
  const notifier = createPushNotifier({
    dataFile: path.join(directory, "subscriptions.json"),
    webPush: { setVapidDetails() {} }
  });

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await notifier.initialize();
  await assert.rejects(notifier.subscribe({
    endpoint: "http://push.example/subscription",
    keys: { p256dh: "public-key", auth: "auth-key" }
  }), { statusCode: 400 });
  assert.throws(() => createPushNotifier({
    dataFile: path.join(directory, "partial.json"),
    webPush: { setVapidDetails() {} },
    publicKey: "test-public-key"
  }), /Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT together/);
});
