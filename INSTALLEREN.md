# Live testen — donker/goud thema op de bestaande app

Eén los CSS-bestand. Je markup, `styles.css` en `app.js` blijven ongewijzigd.
Aanzetten is één regel, uitzetten is die regel weghalen.

## 1. Backup maken

Open PowerShell in `C:\Users\Arnold\Documents\Visual Code` en doe **één** van deze twee:

**Kopie van de map** (snelst, altijd goed):

    Copy-Item -Recurse "Band-admin-2" "Band-admin-2-backup-2026-09-05"

**Of via git** (netter, want je hebt een repo):

    cd Band-admin-2
    git add -A
    git commit -m "voor thema-test"
    git switch -c thema-donker-goud

Met git kun je later in één commando terug: `git switch main`.

## 2. Bestand plaatsen

Zet `theme-bandadmin.css` in de root van `Band-admin-2`, naast `styles.css`.

## 3. Aanzetten

In `index.html`, direct **ná** de bestaande stylesheet-regel:

```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="theme-bandadmin.css">   <!-- thema-test -->
```

De regel moet er ná staan — anders wint het oude thema.

Ook leuk voor de PWA-tegel (optioneel, in de `<head>`):

```html
<meta name="theme-color" content="#0F0D0C">
```

De twee opgeslagen pagina-kopieën (`... inlog.html`, `... nieuw liedje.html`) zijn
browser-saves, geen echte pagina's van de app — daar hoef je niets te doen. De app
zelf is één pagina met alle views (`index.html`), dus met die ene regel is
**alles** om: login, liedjes, songweergave, editor, setlist, kiezer, taken,
akkoorden, instellingen.

## 4. Uitzetten

Haal de `theme-bandadmin.css`-regel weg. Meer niet.
Wil je kunnen wisselen tijdens de repetitie, zet dan `disabled` erop en toggle het
vanuit de console: `document.querySelector('link[href*=theme-bandadmin]').disabled = false`

## 5. Andere band, ander accent

Bovenaan `theme-bandadmin.css` staat `:root`. Voor een andere band verander je
in de praktijk twee dingen:

    --accent: #E3B23C;      /* de merkkleur */
    --accent-ink: #17130F;  /* tekstkleur óp die merkkleur */

plus `logo-small.png`. De rest van het thema volgt automatisch.

## Waar op te letten bij de test

- **Akkoorden zijn goud in plaats van blauw.** Blauw (#2563eb) haalt op een
  donkere achtergrond geen leesbaar contrast. Dit is de belangrijkste wijziging;
  check op het podium of het bij dimlicht en bij fel zonlicht werkt.
- **Sectiekleuren** houden hun betekenis (couplet grijsblauw, refrein goud,
  solo oranje, brug paars, intro/outro turkoois), maar zijn opnieuw gekozen voor
  donker.
- **Groen blijft groen** voor sessie/online/voetschakelaar-aan — dat is status,
  geen merk.
- **Batterij**: donker scheelt echt op een OLED-telefoon tijdens een lange set.

Wat ik nog niet aanraakte: de emoji-iconen (🎲 ⚙️ 🦶) en de layout/indeling.
Die staan wel anders in het mobiele ontwerp (`Band-admin Mobiel.dc.html`,
optie 1b en 1d) — zeg het als je die stap ook in de echte app wil.
