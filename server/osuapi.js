// osu! API v2 mit Client-Credentials.

const BASE = 'https://osu.ppy.sh';

export function lastGameFrom(match) {
  const users = new Map((match.users ?? []).map((user) => [user.id, user.username]));
  const game = match.events?.filter((event) => event.game?.end_time).at(-1)?.game;
  if (!game) return null;
  return {
    id: game.id,
    mapId: game.beatmap_id ?? game.beatmap?.id,
    rows: game.scores.map((score) => ({
      name: users.get(score.user_id) ?? String(score.user_id),
      score: score.score,
      accuracy: score.accuracy * 100,
      combo: score.max_combo,
      misses: score.statistics?.count_miss ?? 0,
      passed: score.passed ?? score.match?.pass ?? true,
      mods: score.mods ?? [],
    })),
  };
}

export class OsuApi {
  constructor({ clientId, clientSecret, fetcher = fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetcher = fetcher;
    this.token = null;
    this.expires = 0;
  }

  async authorize() {
    if (this.token && Date.now() < this.expires) return this.token;
    const response = await this.fetcher(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: Number(this.clientId), client_secret: this.clientSecret, grant_type: 'client_credentials', scope: 'public' }),
    });
    if (!response.ok) throw new Error(`API-Anmeldung fehlgeschlagen (${response.status})`);
    const data = await response.json();
    this.token = data.access_token;
    this.expires = Date.now() + (data.expires_in - 60) * 1000;
    return this.token;
  }

  async get(path) {
    const token = await this.authorize();
    const response = await this.fetcher(`${BASE}/api/v2${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`API ${path}: ${response.status}`);
    return response.json();
  }

  async beatmap(id) {
    const map = await this.get(`/beatmaps/${id}`);
    return {
      mapId: map.id,
      setId: map.beatmapset_id,
      title: map.beatmapset.title,
      artist: map.beatmapset.artist,
      creator: map.beatmapset.creator,
      version: map.version,
      stars: map.difficulty_rating,
      bpm: map.bpm,
      length: map.total_length,
      cs: map.cs,
      ar: map.ar,
      od: map.accuracy,
      cover: map.beatmapset.covers?.['cover@2x'] ?? map.beatmapset.covers?.cover ?? null,
    };
  }

  /** Letztes abgeschlossenes Spiel einer Lobby als einheitliche Ergebniszeilen. */
  async lastGame(mpId) {
    return lastGameFrom(await this.get(`/matches/${mpId}`));
  }
}
