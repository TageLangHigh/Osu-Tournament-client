# Matchdeck

Desktop-App für osu!-Turniere: Spielansicht, Regie und Overlay in einem Fenster. Für offizielles Bancho stable. Kein offizielles osu!-Produkt.

## Start

`Matchdeck.exe` aus den [Releases](https://github.com/TageLangHigh/Osu-Tournament-client/releases) laden und doppelklicken. Sie ist nicht signiert, Windows warnt deshalb beim ersten Start: „Weitere Informationen“, dann „Trotzdem ausführen“.

Aus dem Quellcode: `npm install`, dann `npm run app`. Die Datei baust du mit `npm run build:exe`.

- Overlay für OBS, solange die App läuft: <http://127.0.0.1:7270/overlay> als Browserquelle in Leinwandgröße

## Erste Schritte

1. **Demo starten**, Match öffnen und **Lobby erstellen**. Das läuft ganz ohne Konto und Internet.
2. Unter **Verbindungen** gibt es Knöpfe, um Fehlerfälle zu üben.
3. Für ein echtes Turnier: unter **Turnier** Teams und Pools einfügen, Bracket erzeugen, unter **Verbindungen** IRC und API eintragen und osu!tourney einrichten. Der Client braucht osu!supporter.

## Spielansicht

| Modus | Quelle | Wofür |
|---|---|---|
| Eingebaut | Demo oder importierte `.osr` plus `.osz` | Qualifier und Replays nebeneinander, mit deinem Skin, Map-Hintergrund und Musik |
| osu!tourney aufnehmen | Fensteraufnahme unter dem Overlay, Scores über tosu | Live-Matches auf Bancho, im Originalbild des Clients |

Der Skin kommt aus deinem osu!-Ordner, Standard ist der in osu! gewählte. Matchdeck liefert selbst keine osu!-Grafiken mit. Ohne osu!-Ordner läuft eine schlichte Ersatzdarstellung. Die eingebaute Ansicht kann bisher nur osu!standard.

## Daten

Alles liegt im Ordner `data/`. Zugangsdaten stehen getrennt in `data/secrets.json`, gehen nie an den Browser und lassen sich unter Verbindungen löschen. Der Server hört nur auf diesen Rechner. Für einen zweiten PC im LAN gibt es `MATCHDECK_HOST`, das ist aber ungeschützt.

## Tests

```bash
npm test
```

Mit gesetztem `MATCHDECK_OSU` (Pfad zum osu!-Ordner) läuft zusätzlich der Vergleich gegen deine echten Replays.

Die Recherche zu den Problemen des alten Clients steht in [docs/RECHERCHE.md](docs/RECHERCHE.md).
