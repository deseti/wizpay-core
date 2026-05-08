self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  // Keep runtime behavior network-first while making the service worker a real
  // fetch handler for Android installability checks and beforeinstallprompt.
  event.respondWith(fetch(event.request));
});
