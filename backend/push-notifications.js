const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function isValidSubscription(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof input.endpoint !== "string" || input.endpoint.length > 2048
    || typeof input.keys?.p256dh !== "string" || input.keys.p256dh.length > 200
    || !/^[A-Za-z0-9_-]+$/.test(input.keys.p256dh)
    || typeof input.keys?.auth !== "string" || input.keys.auth.length > 200
    || !/^[A-Za-z0-9_-]+$/.test(input.keys.auth)) {
    return false;
  }
  try {
    return new URL(input.endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

function createPushNotifier({ dataFile, webPush, publicKey, privateKey, subject, logger = console }) {
  const configuredValues = [publicKey, privateKey, subject].filter(Boolean).length;
  if (configuredValues !== 0 && configuredValues !== 3) {
    throw new Error("Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT together.");
  }
  const configured = configuredValues === 3;
  if (configured) webPush.setVapidDetails(subject, publicKey, privateKey);

  let writeQueue = Promise.resolve();

  async function readFile() {
    const contents = await fs.readFile(dataFile, "utf8");
    const subscriptions = JSON.parse(contents);
    if (!Array.isArray(subscriptions)) {
      throw new Error("Push subscription data file must contain a JSON array.");
    }
    return subscriptions;
  }

  function updateFile(update) {
    const operation = writeQueue.then(async () => {
      const subscriptions = await readFile();
      const result = await update(subscriptions);
      const temporaryFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryFile, `${JSON.stringify(subscriptions, null, 2)}\n`, "utf8");
        await fs.rename(temporaryFile, dataFile);
      } catch (error) {
        await fs.rm(temporaryFile, { force: true });
        throw error;
      }
      return result;
    });
    writeQueue = operation.catch(error => {
      logger.error("Push subscription update failed:", error.message);
    });
    return operation;
  }

  async function remove(endpoint) {
    return updateFile(subscriptions => {
      const filtered = subscriptions.filter(subscription => subscription.endpoint !== endpoint);
      subscriptions.splice(0, subscriptions.length, ...filtered);
    });
  }

  return {
    configured,
    publicKey: configured ? publicKey : null,

    async initialize() {
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      try {
        await fs.access(dataFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.writeFile(dataFile, "[]\n", { flag: "wx" });
      }
    },

    async subscribe(input) {
      if (!isValidSubscription(input)) {
        const error = new Error("Invalid browser push subscription.");
        error.statusCode = 400;
        throw error;
      }
      return updateFile(subscriptions => {
        const subscription = {
          endpoint: input.endpoint,
          keys: { p256dh: input.keys.p256dh, auth: input.keys.auth }
        };
        const existingIndex = subscriptions.findIndex(item => item.endpoint === input.endpoint);
        if (existingIndex < 0) subscriptions.push(subscription);
        else subscriptions[existingIndex] = subscription;
      });
    },

    async unsubscribe(endpoint) {
      if (typeof endpoint !== "string" || endpoint.length > 2048) {
        const error = new Error("Invalid browser push endpoint.");
        error.statusCode = 400;
        throw error;
      }
      return remove(endpoint);
    },

    async notifyNewAppointment() {
      if (!configured) return;
      await writeQueue;
      const subscriptions = await readFile();
      const payload = JSON.stringify({
        title: "New appointment request",
        body: "A new appointment was booked. Sign in to view the details.",
        url: "/?staff=1"
      });
      for (const subscription of subscriptions) {
        try {
          await webPush.sendNotification(subscription, payload, { TTL: 60, urgency: "high" });
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await remove(subscription.endpoint);
          } else {
            logger.error("Could not send a browser push notification:", error.message);
          }
        }
      }
    }
  };
}

module.exports = { createPushNotifier, isValidSubscription };
