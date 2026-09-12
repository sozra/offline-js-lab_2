export function readStorage(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function readBooleanStorage(key: string, fallback: boolean): boolean {
  const value = readStorage(key, String(fallback))
  return value === 'true' ? true : value === 'false' ? false : fallback
}

export function readNumberStorage(key: string, fallback: number): number {
  const raw = readStorage(key, String(fallback))
  if (!raw.trim()) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function writeStorage(key: string, value: string | number | boolean): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // localStorage is a convenience; the app must remain usable if it is unavailable.
  }
}
