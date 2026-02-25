self.addEventListener("install", (event) => {
  console.log("✅ Service Worker Installed");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("✅ Service Worker Activated");
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { 
    title: "Learning Alert!", 
    body: "Time to check in with Professor Dino!" 
  };

  const options = {
    body: data.body,
    icon: "/icons/icon-192x192.png", // Ensure this exists or matches your manifest
    badge: "/icons/badge-72x72.png",
    vibrate: [100, 50, 100],
    data: {
      url: data.url || "/"
    },
    actions: [
      { action: 'open', title: 'Start Learning' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});

self.addEventListener("fetch", () => {});
