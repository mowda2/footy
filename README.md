# Footy

Sign-ups, e-transfer check-offs, a waitlist and fair teams for our Sunday games.
Share one link in the group chat instead of copy-pasting the numbered list.

## How it works

**Players**
- Open the game link, type your name, tap **Add me**. If it's full you go on the waitlist and move up automatically when someone drops.
- Send the e-transfer, then tap **I've sent my e-transfer**. Nobody has to chase or track payments.
- Bringing a friend? **Add a guest**. Their spot is under your name and their e-transfer is on you.
- Already on a list the organizer pasted in? Tap **That's me** next to your name.
- **Copy list for WhatsApp** gives you the familiar numbered list (with ✅ for paid) to paste in the chat.

**Organizers** (whoever books the field, using the shared PIN)
- Schedule a game: venue, field, time, price, e-transfer address, spots, pay-by deadline.
- Paste names straight from the group chat.
- After the deadline, unpaid spots get a yellow card. **Move unpaid to waitlist** hands those spots to people waiting.
- **Make teams**: rate players 1 to 5 once (only organizers see ratings), get balanced teams, tap two players to swap, publish.
- **Schedule next week** copies the game a week ahead.

## Tech

Plain HTML, CSS and JavaScript with no build step, hosted on Vercel.
Data lives in Supabase (Postgres). The browser only ever calls the `footy_*`
functions in `supabase/migrations/001_footy_schema.sql`; the tables are locked
behind row-level security, the organizer PIN is stored as a bcrypt hash, and
each device gets a random token so only you (or an organizer) can change your spot.

Settings (Supabase URL and public key, time zone, defaults for new games) are in `config.js`.

To run locally, serve the folder with any static server, e.g. `npx serve .`
