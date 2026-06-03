/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST)

// Remove stale precache entries from previous SW versions
cleanupOutdatedCaches()

// ── Push notification handler ────────────────────────────────────────────────
self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return

  let payload: {
    title?: string
    body?: string
    icon?: string
    badge?: string
    tag?: string
    data?: { ticker?: string; signal?: string; tier?: number; url?: string }
  }

  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'Picker Alert', body: event.data.text() }
  }

  const title = payload.title ?? 'Picker Alert'
  const options: NotificationOptions = {
    body: payload.body ?? '',
    icon: payload.icon ?? '/pwa-192.png',
    badge: payload.badge ?? '/pwa-192.png',
    tag: payload.tag ?? 'picker-alert',
    // Reuse existing notification with same tag (replaces older alert)
    renotify: true,
    data: payload.data ?? {},
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// ── Notification click handler ───────────────────────────────────────────────
self.addEventListener('notificationclick', (event: NotificationClickEvent) => {
  event.notification.close()

  const ticker: string | undefined = event.notification.data?.ticker
  const targetUrl = ticker ? `/?ticker=${ticker}` : '/'

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus existing open window if available
        for (const client of clientList) {
          const url = new URL(client.url)
          if (url.origin === self.location.origin && 'focus' in client) {
            // Navigate existing window to the ticker
            client.postMessage({ type: 'NAVIGATE_TICKER', ticker })
            return (client as WindowClient).focus()
          }
        }
        // No open window — open a new one
        return self.clients.openWindow(targetUrl)
      }),
  )
})
