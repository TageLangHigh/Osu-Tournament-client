# Was am alten Tournament Client nervt

Stand: November 2026. Es gibt zwei „alte“ Clients, die zusammen benutzt werden:

- **osu!tourney** (stable): startet pro Spieler einen eigenen osu!-Client.
- **osu!(lazer) `--tournament`**: Overlay mit Mappool und Bracket, das über Textdateien an osu!tourney hängt.

Die Belege sind unterschiedlich stark. Die GitHub-Issues und Wiki-Seiten sind direkt nachlesbar. Forenbeiträge sind Einzelmeinungen, oft ältere. Reddit- oder Discord-Diskussionen habe ich nicht auswerten können.

| Problem | Beleg | Lösung in Matchdeck |
|---|---|---|
| Einrichtung von Hand: frische Installation, `tournament.cfg`, leere `ipc.txt`, Startverknüpfung, Höhe an mehreren Stellen gleich eintragen | [osu!tourney Setup](https://osu.ppy.sh/wiki/en/osu%21_tournament_client/osu%21tourney/Setup), [Streaming-Guide](https://mirai.blog/osu-lazer-tournament-streaming-guide/) | Ein Start, eine Browserquelle, Overlay skaliert sich selbst |
| OBS-Bastelei: Chroma Key, je Spieler eine Fensterquelle, Crop per Hand | [Streaming-Guide](https://mirai.blog/osu-lazer-tournament-streaming-guide/) | Durchsichtiger Mittelteil statt Chroma Key, ein Fenster reicht |
| Etwa 300 MB je Client, Guide empfiehlt 16 GB RAM | [Streaming-Guide](https://mirai.blog/osu-lazer-tournament-streaming-guide/) | Eingebaute Ansicht braucht keine Client-Kopie je Spieler |
| Speicher läuft bei Hintergrundvideos voll, System kann einfrieren | [Streaming-Guide](https://mirai.blog/osu-lazer-tournament-streaming-guide/), [#1109](https://github.com/ppy/osu-stable-issues/issues/1109) | Kein Video-Decoder im Overlay |
| osu!supporter nötig, nur Hauptmonitor, Konfig nur bei geschlossenem Client änderbar | [Setup](https://osu.ppy.sh/wiki/en/osu%21_tournament_client/osu%21tourney/Setup), [Troubleshooting](https://osu.ppy.sh/wiki/en/osu%21_tournament_client/osu%21tourney/Troubleshooting) | Für Matchdeck selbst kein Supporter, jeder Monitor, alles im Betrieb änderbar. Für die Live-Aufnahme bleibt osu!tourney aber nötig |
| Lobby wird nur mit exaktem Namensschema gefunden, Fehlerbehebung per „Panic“-Knopf | [Troubleshooting](https://osu.ppy.sh/wiki/en/osu%21_tournament_client/osu%21tourney/Troubleshooting) | Lobby per Knopf oder mp-Link, Raumname wird automatisch korrekt gesetzt |
| Szene springt nach jedem Ban auf Gameplay | [#24857](https://github.com/ppy/osu/issues/24857), [#29876](https://github.com/ppy/osu/issues/29876) | Szene hängt nur am Match-Zustand, nie an der Lobby-Map, Test vorhanden |
| Falsche Picks nur per Rechtsklick entfernbar | [#24857](https://github.com/ppy/osu/issues/24857) | Rückgängig und Wiederholen für alles |
| Protects fehlen im Standard-Client | [#36200](https://github.com/ppy/osu/pull/36200) | Protects je Runde einstellbar |
| Mehrere Turniere erfordern Dateien schieben, offen seit 2020 | [#9199](https://github.com/ppy/osu/issues/9199) | Turnierprofile, Umschalten, Export und Import |
| Stream, mp-Link und IRC zeigen verschiedene Scores | [#825](https://github.com/ppy/osu-stable-issues/issues/825) | Quellen werden verglichen, Widerspruch stoppt die Automatik |
| Score von Spielern, die gegangen sind, zählt weiter | [#1227](https://github.com/ppy/osu-stable-issues/issues/1227) | Pro Map wird neu gerechnet, nur Roster-Spieler zählen |
| Anzeige und tatsächliche Mods weichen ab | [#683](https://github.com/ppy/osu-stable-issues/issues/683) | Mods kommen aus `!mp settings`, Regelcheck bei „alle bereit“ |
| Team-Summen drehen sich je nach Scoring-Modus | [#17824](https://github.com/ppy/osu/issues/17824) | Eine feste Rechnung je Turnier, Siegbedingung pro Runde |
| Keine Accuracy-Siegbedingung im Standard | [VCL-Overlay](https://awesome.ecosyste.ms/projects/github.com%2Fvncommunityleague%2Fvcl-tournament-overlay-tosu) | Score, Accuracy, Combo, wenigste Misses |
| Chat fehlt, weil `ipc-channel.txt` nicht geschrieben wird | [#495](https://github.com/ppy/osu-stable-issues/issues/495), [Diskussion 21055](https://github.com/ppy/osu/discussions/21055) | Chat kommt direkt über IRC, keine Textdateien |
| Stottern bei HT, Puffer-Pausen, alle warten auf den langsamsten Spieler | [#1008](https://github.com/ppy/osu-stable-issues/issues/1008), [Setup](https://osu.ppy.sh/wiki/en/osu%21_tournament_client/osu%21tourney/Setup) | Eingebaute Ansicht nutzt eine Uhr, ein Ausfall stoppt nur ein Feld |
| Flaggen und Einstellungen gehen verloren | [Forum](https://osu.ppy.sh/community/forums/topics/1938367) | Jede Aktion sofort auf der Platte, Wiederherstellung nach Absturz getestet |
| Maximal 64 Teams, Bracket-Editor von Hand | [#20781](https://github.com/ppy/osu/issues/20781), [#24378](https://github.com/ppy/osu/issues/24378) | Bracket aus der Setzliste, getestet mit 128 Teams |
| Hintergründe laden nicht immer | [#24993](https://github.com/ppy/osu/issues/24993), [#26550](https://github.com/ppy/osu/issues/26550) | Fehlt ein Bild, bleibt die Karte trotzdem lesbar |
| Kein Chinesisch eingebbar, Exit-Knopf verschwindet, Infos weg bei 720p | [#9118](https://github.com/ppy/osu/issues/9118), [#8223](https://github.com/ppy/osu/issues/8223), [#9200](https://github.com/ppy/osu/issues/9200) | Normale Webtexte und feste Bühne mit Skalierung |
| Referee-Arbeit läuft komplett über getippte Befehle | [Befehlsliste](https://osu.ppy.sh/wiki/en/osu%21_tournament_client/osu%21tourney/Tournament_management_commands), [Forum](https://osu.ppy.sh/community/forums/topics/1992981) | Regie mit Knöpfen, Regelcheck und Korrektur per Klick |
| Standard-Lazer eignet sich laut Dev-Antwort kaum für Turniere, Lazer-Spectate im Tournament-Client fehlt | [Forum](https://osu.ppy.sh/community/forums/topics/1992981), [#16911](https://github.com/ppy/osu/issues/16911) | Noch offen, siehe unten |

## Was Matchdeck nicht ersetzen kann

- **Live-Gameplay:** Die Live-Ansicht braucht weiter osu!tourney. Matchdeck baut keinen eigenen Spectate-Client für Bancho, denn dafür müsste sich ein Programm als osu!-Client ausgeben. Ein Zweitkonto dafür wäre außerdem Multi-Accounting ([Regeln](https://osu.ppy.sh/wiki/en/Rules), [Bot-Konten](https://osu.ppy.sh/wiki/en/Bot_account)). Die eingebaute Ansicht zeigt deshalb nur Replays und die Demo.
