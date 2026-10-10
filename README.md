# NextUp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/olgeestuff/nextup)

A shared queue anyone can join with a link. Everyone sees the order live. One owner controls it.

Built for audio rooms (Clubhouse, Spaces, Discord stages) where people need to get in line and see where they are, but it works for any first-come, first-served list: open mics, office hours, Q&A, walk-in service.

- No sign-up and no app to install. A link is all anyone needs.
- People add their own name, see their place, and can leave or fix their own name.
- The order updates on every screen within a moment of any change.
- Only the owner can reorder, remove names, close the queue, or clear it.
- Works on a small phone, with a keyboard, and with a screen reader.
- Free to run on Cloudflare's free plan. One deployment serves unlimited queues.

## How it works

Creating a queue gives you two links.

| Link | Looks like | What it allows |
| --- | --- | --- |
| Queue link | `https://your-app.workers.dev/q/k7m2xw9pqa` | See the order and add a name. Share this one. |
| Owner link | `https://your-app.workers.dev/q/k7m2xw9pqa#owner=…` | Everything above, plus reorder, remove, close, clear. Keep this one. |

When you open the owner link, the page saves the owner key on that device and removes it from the address bar. From then on the address bar shows only the queue link, so copying it or sharing your screen cannot give away control. To manage the queue from another device or add a co-host, use **Queue settings → Copy owner link**.

If the owner link ever gets out, **Reset owner link** makes every old copy stop working at once. The device you reset from stays the owner.

## Who owns the order

This is the part that has to be right, so here is exactly how it is decided.

1. **One place decides.** Each queue lives in a single Cloudflare Durable Object, so there is exactly one copy of the list. Every action checks the list and changes it in one unbroken step. When two people tap "Join" in the same instant, one of them is processed first and gets the earlier place. There are no ties and no two screens that disagree.
2. **Joining always means the end of the line.** Nobody can pick their position. The server appends, in the order requests arrive.
3. **Changing the order needs the owner key.** The key is a 32-character random secret created with the queue. The server keeps only a SHA-256 hash of it, so even someone who could read the stored data could not recover the key. Requests to move, remove, close, clear or reset without the right key get `403`.
4. **Reorders are relative, not wholesale.** The owner's screen sends "move Ada in front of Tunde", never "here is the new list". So if someone joins while the owner is dragging, the new person is not wiped out.
5. **Your own entry is yours.** When you join, your browser gets a private token for that one entry. It lets you leave or correct your own name and nothing else. Names the owner adds for other people can only be changed by the owner.
6. **Light guards against queue jumping.** One spot per device and one spot per name (ignoring case and spaces). A determined person can get around the device rule by clearing their browser data, which is why the owner can always remove an entry.

## Put it online (free)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account. Durable Objects with SQLite storage, which this app uses, are included in the free plan.

### Option A: from a terminal

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npx wrangler login     # opens the browser once to connect your Cloudflare account
npm run deploy
```

Wrangler prints your link, for example `https://nextup.your-subdomain.workers.dev`. That is the page to share with anyone who wants to create a queue.

### Option B: without a terminal

Click the **Deploy to Cloudflare** button at the top of this page, sign in to Cloudflare and confirm. Cloudflare copies the project into your own GitHub account, builds it and deploys it, and redeploys whenever you push a change.

### Your own domain

In the Cloudflare dashboard open the Worker, then **Settings → Domains & Routes → Add → Custom domain**, for example `queue.yourdomain.com`. The domain must be on Cloudflare.

## Run it on your computer

```bash
npm install
npm run dev      # http://localhost:8787
npm test         # in a second terminal, while dev is running
```

## Settings

At the top of `src/worker.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_ENTRIES` | 300 | Most names one queue holds |
| `MAX_NAME_LENGTH` | 40 | Longest name |
| `MAX_TITLE_LENGTH` | 60 | Longest queue title |
| `MAX_VIEWERS` | 5000 | Most live viewers per queue |
| `EXPIRY_DAYS` | 30 | A queue is deleted after this many days without changes |

At the top of the script in `public/index.html`, set `REPO_URL` to your repository address to show a "Source code" link in the footer.

To rename the app, change `name` in `wrangler.jsonc` (this sets the link) and the word "NextUp" in `public/index.html`.

## What the free plan covers

Cloudflare's free plan allows 100,000 requests a day across all your Workers. Opening a queue costs about three requests per viewer (the page, the first load, the live connection). After that the server pushes changes down that one connection, so watching costs almost nothing. Each join, move or removal is one more request. A two-hour room with 500 people watching and 100 joining comes to a few thousand requests, a small slice of one day's allowance. If you outgrow it, moving to the paid plan needs no code changes.

## Good to know

- **Do not lose the owner link.** There are no accounts, so there is no "forgot password". The device that created the queue remembers it (see "Queues you manage on this device" on the start page), but clearing that browser's data forgets it. Copy the owner link somewhere safe for any queue that matters.
- **Names are public.** Anyone with the queue link sees every name. The app stores nothing else about people: no accounts, no emails, no cookies, no tracking.
- **Queues expire.** After `EXPIRY_DAYS` without changes a queue and its names are deleted.
- **It is a queue, not a moderation tool.** Anyone with the link can add a name while the queue is open. The owner can remove entries and close the queue to new names.

## Files

```
src/worker.js        the server: routes, the queue, ownership rules
public/index.html    the whole interface, one file, no build step
test/api.test.mjs    tests for the rules above
wrangler.jsonc       Cloudflare configuration
```

## API

All under `/api`. Owner calls send `Authorization: Bearer <owner key>`.

| Call | Who | Body |
| --- | --- | --- |
| `POST /api/queues` | anyone | `{ title }` → `{ id, ownerKey }` |
| `GET /api/q/:id` | anyone | → `{ state, owner }` |
| `GET /api/q/:id/ws` | anyone | WebSocket; sends `{ type: "state", state }` on every change |
| `POST /api/q/:id/join` | anyone (owner when closed) | `{ name, device }` → `{ entryId, token, state }` |
| `POST /api/q/:id/leave` | entry holder or owner | `{ entryId, token }` |
| `POST /api/q/:id/rename` | entry holder or owner | `{ entryId, token, name }` |
| `POST /api/q/:id/move` | owner | `{ entryId, beforeId }` (`beforeId: null` moves to the end) |
| `POST /api/q/:id/remove` | owner | `{ entryId }` |
| `POST /api/q/:id/settings` | owner | `{ open?, title? }` |
| `POST /api/q/:id/clear` | owner | `{}` |
| `POST /api/q/:id/rotate` | owner | `{}` → `{ ownerKey }` |

## License

MIT. See [LICENSE](LICENSE).

The interface embeds a subset of the typeface Big Shoulders Display, copyright The Big Shoulders Project Authors, under the SIL Open Font License 1.1. See [licenses/BigShouldersDisplay-OFL.txt](licenses/BigShouldersDisplay-OFL.txt).
