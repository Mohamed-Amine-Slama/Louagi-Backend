// Expo push delivery. Posts messages to Expo's push service in batches of 100
// (Expo's per-request limit) and reports per-token outcomes so the caller can
// prune dead tokens. Pure-ish: `fetchImpl` is injectable for tests.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

export function chunk(arr, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// messages: [{ to, title, body, data? }, ...]
// returns { pushed, failed, invalidTokens } — invalidTokens are tokens Expo
// reported as DeviceNotRegistered (safe to delete).
export async function sendExpoPush(
  messages,
  { fetchImpl = fetch, accessToken = process.env.EXPO_ACCESS_TOKEN } = {},
) {
  let pushed = 0;
  let failed = 0;
  const invalidTokens = [];

  if (!Array.isArray(messages) || messages.length === 0) {
    return { pushed, failed, invalidTokens };
  }

  for (const batch of chunk(messages, BATCH_SIZE)) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const res = await fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
      });
      const json = await res.json().catch(() => null);
      const tickets = Array.isArray(json?.data) ? json.data : [];

      batch.forEach((msg, i) => {
        const ticket = tickets[i];
        if (ticket && ticket.status === 'ok') {
          pushed += 1;
        } else {
          failed += 1;
          if (ticket?.details?.error === 'DeviceNotRegistered' && msg?.to) {
            invalidTokens.push(msg.to);
          }
        }
      });
    } catch {
      // Network/transport failure for the whole batch.
      failed += batch.length;
    }
  }

  return { pushed, failed, invalidTokens };
}
