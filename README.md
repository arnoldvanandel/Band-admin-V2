# Kolonel & The Parkers — Songbeheer

Deze map is gereconstrueerd vanaf de live Firebase Hosting site
(`https://band-admin-76dad.web.app/`), nadat de originele projectmap
verloren was gegaan. De app gebruikt géén build-stap (gewone ES-modules),
dus dit is de daadwerkelijke broncode zoals die ook online draait.

## Structuur
- `index.html` — hoofdpagina (Tailwind via CDN, Roboto Mono via Google Fonts)
- `styles.css` — eigen aanvullende stijlen
- `js/app.js` — hoofdapplicatie (SPA: view-switching, auth, dashboard, song editor)
- `js/auth.js` — Firebase Auth (login/logout)
- `js/firebase-config.js` — Firebase-projectconfig + Firestore-init (offline persistence). **Staat in `.gitignore`** en blijft lokaal; zie `js/firebase-config.example.js`.
- `js/firestore.js` — Firestore CRUD-laag (songs, setlists, chords, presence, todos, ...)
- `js/song-format.js` — parser/serializer voor songteksten met akkoorden
- `js/pdf-import.js` — PDF-import van chord sheets (via PDF.js)
- `js/chord-diagram.js` — SVG-renderer voor gitaargrepen
- `js/seed-data.js` — voorbeelddata

## Lokaal draaien
Omdat dit ES-modules gebruikt (`type="module"`), moet je het via een
lokale webserver openen — niet met `file://`, dat blokkeert imports.

Met Python:
```
python3 -m http.server 8000
```
Met Node (npx):
```
npx serve .
```
Open daarna `http://localhost:8000`.

## Firebase-config lokaal
De projectgegevens (API-sleutel, appId, …) staan bewust niet in deze
openbare repository. Maak ze lokaal aan door het voorbeeld te kopiëren:

```
cp js/firebase-config.example.js js/firebase-config.js
```

Vul daarna in `js/firebase-config.js` de waarden in uit:
Firebase Console → Projectinstellingen → Je apps → SDK setup & config.

Let op: een Firebase **web**-API-sleutel is geen geheim (bezoekers kunnen hem
in de browser zien). De beveiliging van je data wordt geregeld door de
Firestore Security Rules, niet door de sleutel.

## Ontbrekende, niet-kritieke bestanden
Deze twee PWA-bestanden werden niet teruggevonden bij de reconstructie,
de app werkt prima zonder, maar voor volledige PWA/installeerbaarheid
kun je ze opnieuw aanmaken:
- `manifest.webmanifest` (in de hoofdmap)
- `icons/icon-192.png` (in `icons/`)

## Git
Deze repository staat op GitHub en is openbaar. `js/firebase-config.js` wordt
genegeerd; clone je de repo op een andere machine, maak dan dat bestand aan
zoals hierboven beschreven.

## Firebase deployen
Deze map deployt standaard naar de **testsite** (`band-admin-76dad-9c068.web.app`)
binnen hetzelfde Firebase-project `band-admin-76dad`. Firestore, Auth en de rest
van de config worden gedeeld met de live site.

Vereisten:
- Node.js/npm (geen globale installatie nodig, we gebruiken `npx`)
- Eenmalig inloggen: `npx firebase-tools login` (of `npm install -g firebase-tools`)

Deploy naar de testsite:
```
npx --yes firebase-tools@latest deploy --only hosting:test
```

De live site (`band-admin-76dad.web.app`) staat **niet** in deze `firebase.json`
en wordt dus nooit geraakt vanuit deze map. Wil je later wél naar live deployen,
voeg dan in `.firebaserc` een tweede target toe (bijv. `live`) en in `firebase.json`
een tweede hosting-config, en deploy met `--only hosting:live`.
