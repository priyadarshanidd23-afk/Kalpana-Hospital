self.addEventListener("push", event => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = {};
    }
  }

  event.waitUntil(self.registration.showNotification(payload.title || "New appointment request", {
    body: payload.body || "Sign in to the clinic website to view the new request.",
    data: { url: payload.url || "/?staff=1" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL("/?staff=1", self.location.origin);
  const requestedUrl = event.notification.data && event.notification.data.url;
  if (typeof requestedUrl === "string") {
    const candidate = new URL(requestedUrl, self.location.origin);
    if (candidate.origin === self.location.origin) target.href = candidate.href;
  }
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windowClients => {
    const existing = windowClients.find(client => "focus" in client);
    if (existing) {
      return existing.navigate(target.href).then(client => client.focus());
    }
    return clients.openWindow(target.href);
  }));
});
