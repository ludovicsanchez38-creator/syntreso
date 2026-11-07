// Notification de mutation des données. Le lot agent (digest) s'y branche :
// chaque écriture (forecast, proposition validée) régénère le digest de l'agent.

const listeners = []

export function subscribeDataChanged(fn) {
  listeners.push(fn)
}

export async function onDataChanged() {
  for (const fn of listeners) {
    try {
      await fn()
    } catch (err) {
      console.error('Listener onDataChanged en erreur:', err.message)
    }
  }
}
