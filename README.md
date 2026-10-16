# The Family: Mafia party game

A live, browser-based Mafia game. One phone hosts a table, others join with a 4-letter code.

## Run it on your computer

1. Install Node.js 18 or newer from nodejs.org.
2. Open a terminal in this folder (`sites/mafia-game`).
3. Run `npm install` (only needed once).
4. Run `npm start`.
5. Open http://localhost:3000 in your browser.

Players on the same Wi-Fi can join at `http://<your-computer-IP>:3000`.

## Let friends on other networks join (Render, free)

Friends on other networks cannot reach your computer directly, so host the server online:

1. Push this folder to a GitHub repository.
2. On render.com, create a new **Web Service** from that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Name the service `mafia`. Render gives you a public URL like `https://mafia.onrender.com` (the exact name may get a suffix if it's taken). Share it.

Free Render services sleep when idle, so the first visit can take about a minute to wake up.

## How a game plays

- **Host Game**: enter a name, set the rules (number of Mafia, Medic on/off, Detective on/off, max players), then Create Game.
- **Join Game**: enter a name and the 4-letter code shown on the host's screen.
- **Lobby**: the code shows top left. Guests appear in the seats as they join. The host presses **Start First Night** (needs at least 3 players).
- **Night**: each role's card appears. Mafia pick a target together. The Medic picks someone to save and can save themselves once. The Detective checks one player.
- **Day**: "Day time has started." Everyone votes someone out. A tie means nobody goes out, and night comes again after a short pause.
- **Winning**: if a Mafia member is voted out, the Villagers win. Villagers also win once no Mafia are left alive. The Mafia win when only a Mafia member and one other player remain.
- **Play Again**: the host can reset the same table after a game ends.

## Project layout

- `server.js`: game rules, lobbies, and Socket.IO events. Every player only receives what they're allowed to see (their own role, their own checks).
- `public/index.html`, `public/style.css`, `public/app.js`: the front end.
- `package.json`: dependencies (Express, Socket.IO) and the start script.

Note: opening `public/index.html` directly, or using a static preview, will not work for live games. The server must be running.
