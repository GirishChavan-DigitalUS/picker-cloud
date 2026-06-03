/**
 * Web Push notification helpers.
 *
 * Usage:
 *   isPushSupported()            — feature detect
 *   getPushPermission()          — 'default' | 'granted' | 'denied'
 *   subscribeToPush()            — request permission + subscribe + POST to backend
 *   unsubscribeFromPush()        — unsubscribe + DELETE from backend
 */
import axios from 'axios'
import { API_BASE } from './formatters'

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function getPushPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied'
  return Notification.permission
}

/** Fetch the VAPID public key from the backend. Returns null if not configured. */
async function fetchVapidKey(): Promise<string | null> {
  try {
    const { data } = await axios.get<{ publicKey: string }>(`${API_BASE}/push/vapid-key`)
    return data.publicKey
  } catch {
    return null
  }
}

/** Convert URL-safe base64 string to Uint8Array for pushManager.subscribe(). */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

/**
 * Request notification permission, subscribe via PushManager, and POST
 * the subscription to the backend.
 *
 * @returns 'subscribed' | 'denied' | 'unsupported' | 'error'
 */
export async function subscribeToPush(): Promise<'subscribed' | 'denied' | 'unsupported' | 'error'> {
  if (!isPushSupported()) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  try {
    const vapidKey = await fetchVapidKey()
    if (!vapidKey) return 'error'

    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    if (existing) await existing.unsubscribe()

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    })

    const { endpoint, keys } = subscription.toJSON() as {
      endpoint: string
      keys: { p256dh: string; auth: string }
    }

    await axios.post(`${API_BASE}/push/subscribe`, {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    })

    localStorage.setItem('push_subscribed', '1')
    return 'subscribed'
  } catch (err) {
    console.error('[push] subscribe error', err)
    return 'error'
  }
}

/**
 * Unsubscribe from push: removes from PushManager and DELETE from backend.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return

    const { endpoint } = subscription
    await subscription.unsubscribe()
    await axios.delete(`${API_BASE}/push/subscribe`, { data: { endpoint } })
  } catch (err) {
    console.error('[push] unsubscribe error', err)
  } finally {
    localStorage.removeItem('push_subscribed')
  }
}

/** Check if user already has an active push subscription (PushManager + local flag). */
export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false
  try {
    const registration = await navigator.serviceWorker.ready
    const sub = await registration.pushManager.getSubscription()
    return !!sub
  } catch {
    return false
  }
}
