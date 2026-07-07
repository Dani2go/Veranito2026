const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Base de datos ----------
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL. Añade el plugin de PostgreSQL en Railway y enlaza la variable.");
}
const needsSsl = url && !url.includes("railway.internal") && !url.includes("localhost") && !url.includes("127.0.0.1");
const pool = new Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

const COLORS = ["teal", "leaf", "ember", "plum", "sun", "sky", "navy"];

// ---------- Mareas (Marea API) ----------
// El token se lee de la variable de entorno MAREA_TOKEN (configúrala en Railway).
// NUNCA va en el código del navegador: el servidor hace de intermediario y cachea
// la predicción (una sola petición trae meses), para no gastar el cupo gratuito.
const MAREA_TOKEN = process.env.MAREA_TOKEN || "";
const TIDE_LAT = 43.4356, TIDE_LON = -4.0473; // Suances

const SEED = [
  ["dougalls", "Comida en DouGall's", "🍺", "Comida en la fábrica de cerveza artesana de Liérganes. Tablas, birras de barril y terraza.", "Liérganes", "~30 €/persona (51 € con visita+maridaje)", "teal", "Sara"],
  ["casapoli", "Casa Poli", "🦞", "Casa de comidas de culto cerca de Llanes. Sin reservas (llegar 13:00), pescado del día y sidra.", "Puertas de Vidiago (Asturias)", "~35 €/persona", "leaf", "Daniel"],
  ["barbacoa", "Barbacoa en La Moruca", "🔥", "Barbacoa en mi casa, en Tagle. Carne, hielo y tarde larga.", "Tagle", "bote común ~12 €", "ember", "Marta"],
  ["bbk", "Finde del BBK", "🎧", "Pinchada de Petro y Tony que monta Camilo, coincidiendo con el Bilbao BBK Live.", "Bilbao", "9–11 jul · fecha fija", "plum", "Camilo"],
  ["ramales", "Cuevas de Ramales", "🦌", "Visita a las cuevas de Ramales de la Victoria (Covalanas / Cullalvera): arte rupestre y geología. Reservar la visita guiada.", "Ramales de la Victoria", "entrada ~15 €", "sun", "Alex"],
  ["snorkel", "Snorkel en Punta Ballota", "🤿", "Snorkel y playa en Punta Ballota, en Suances. Trae gafas y tubo.", "Suances", "gratis", "sky", "Daniel"],
  ["getaria", "Getaria y noche en Donosti", "🐟", "Homenaje de pescado a la brasa en Getaria y, si apetece, noche de mamoneo por Donosti. Lo de la noche es opcional, pero redondea el plan.", "Getaria (Gipuzkoa)", "comida ~60 € · noche en Donosti aparte", "navy", "Camilo"],
  ["bonito", "Barbacoa de bonito", "🐟", "Viernes 10: barbacoa de bonito coincidiendo con el España–Bélgica de cuartos del Mundial. Pescado a la brasa y partidazo.", "Tagle", "bote común 15 €", "sky", "Daniel"],
  ["asado", "Asado en la lleldería", "🥩", "Asado patagónico al fuego con Sandialito: carnes a la leña cocinadas lento, con producto de animales criados en libertad y técnicas tradicionales de gauchos y pastores. Horario 13:30 h · Duración 4,5 h.", "Merilla", "55 € (bebida incluida)", "ember", "Camilo"],
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE,
      title TEXT NOT NULL,
      emoji TEXT DEFAULT '📍',
      description TEXT DEFAULT '',
      location TEXT DEFAULT '',
      price TEXT DEFAULT '',
      color TEXT DEFAULT 'teal',
      fixed BOOLEAN DEFAULT false,
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS signups (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      UNIQUE(plan_id, name)
    );
    CREATE TABLE IF NOT EXISTS availability (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      day DATE NOT NULL,
      UNIQUE(name, day)
    );
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER REFERENCES polls(id) ON DELETE CASCADE,
      label TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      id SERIAL PRIMARY KEY,
      option_id INTEGER REFERENCES poll_options(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      UNIQUE(option_id, name)
    );
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Sincroniza los planes fijos desde el código en cada arranque.
  // ON CONFLICT (slug) DO UPDATE mantiene el mismo id, así que los apuntados no se pierden.
  for (const [slug, title, emoji, desc, loc, price, color, by] of SEED) {
    await pool.query(
      `INSERT INTO plans (slug, title, emoji, description, location, price, color, fixed, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
       ON CONFLICT (slug) DO UPDATE SET
         title=EXCLUDED.title, emoji=EXCLUDED.emoji, description=EXCLUDED.description,
         location=EXCLUDED.location, price=EXCLUDED.price, color=EXCLUDED.color, fixed=true, created_by=EXCLUDED.created_by`,
      [slug, title, emoji, desc, loc, price, color, by]
    );
  }
  console.log("Planes fijos sincronizados.");
}

const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max);

// Predicción de mareas con caché. La marea es astronómica (apenas cambia), así que
// refrescamos como MUCHO una vez al día (1 petición/día). Con ~98 prepago, cubre el
// verano de sobra. Si el refresco falla un día, seguimos sirviendo lo último guardado.
async function getTides() {
  let cached = null;
  try {
    const r = await pool.query("SELECT data, fetched_at FROM cache WHERE key='tides'");
    if (r.rows[0]) cached = r.rows[0];
  } catch (_) {}

  const now = Date.now();
  const ageMs = cached ? now - new Date(cached.fetched_at).getTime() : Infinity;
  if (cached && ageMs < 24 * 3600 * 1000) return cached.data; // ya refrescado hoy → caché

  if (!MAREA_TOKEN) {
    if (cached) return cached.data;            // sin token pero hay caché previa: úsala
    throw new Error("MAREA_TOKEN no configurado");
  }
  try {
    // Ventana de 16 días (sobra para los 7 que mostramos). Cuesta lo mismo: 1 petición.
    const url = `https://api.marea.ooo/v2/tides?latitude=${TIDE_LAT}&longitude=${TIDE_LON}&duration=23040&interval=60&datum=MSL`;
    const resp = await fetch(url, { headers: { "x-marea-api-token": MAREA_TOKEN } });
    if (!resp.ok) throw new Error("Marea API " + resp.status);
    const full = await resp.json();
    const data = {
      unit: full.unit || "m",
      datum: full.datum || "MSL",
      extremes: (full.extremes || []).map((e) => ({ timestamp: e.timestamp, height: e.height, state: e.state })),
    };
    await pool.query(
      `INSERT INTO cache (key, data, fetched_at) VALUES ('tides', $1, now())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
      [JSON.stringify(data)]
    );
    return data;
  } catch (e) {
    if (cached) return cached.data;            // si el refresco falla, sirve lo último
    throw e;
  }
}

// ---------- API ----------
// Mareas de Suances: devuelve solo los extremos de hoy..+7 días (carga ligera).
app.get("/api/mareas", async (_req, res) => {
  try {
    const data = await getTides();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const startMs = start.getTime() - 864e5;        // desde ayer (continuidad de la curva)
    const endMs = start.getTime() + 9 * 864e5;       // hasta +9 días
    const extremes = (data.extremes || []).filter((e) => {
      const t = e.timestamp * 1000;
      return t >= startMs && t <= endMs;
    });
    res.json({ extremes, unit: data.unit, datum: data.datum });
  } catch (e) {
    console.error("mareas:", e.message);
    res.status(503).json({ error: "tides_unavailable" });
  }
});
app.get("/api/data", async (_req, res) => {
  try {
    const plans = (await pool.query("SELECT * FROM plans ORDER BY fixed DESC, id ASC")).rows;
    const signups = (await pool.query("SELECT plan_id, name FROM signups ORDER BY id")).rows;
    const avail = (await pool.query("SELECT name, to_char(day,'YYYY-MM-DD') AS day FROM availability")).rows;
    const polls = (await pool.query("SELECT * FROM polls ORDER BY created_at DESC")).rows;
    const options = (await pool.query("SELECT * FROM poll_options ORDER BY id")).rows;
    const votes = (await pool.query("SELECT option_id, name FROM poll_votes")).rows;

    const planList = plans.map((p) => ({
      ...p,
      signups: signups.filter((s) => s.plan_id === p.id).map((s) => s.name),
    }));
    const availability = {};
    avail.forEach((a) => {
      (availability[a.name] ||= []).push(a.day);
    });
    const pollList = polls.map((poll) => ({
      id: poll.id,
      question: poll.question,
      created_by: poll.created_by,
      options: options
        .filter((o) => o.poll_id === poll.id)
        .map((o) => ({ id: o.id, label: o.label, votes: votes.filter((v) => v.option_id === o.id).map((v) => v.name) })),
    }));

    res.json({ plans: planList, availability, polls: pollList });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo leer la base de datos" });
  }
});

// Proponer un plan nuevo
app.post("/api/plans", async (req, res) => {
  try {
    const title = clean(req.body.title, 80);
    if (!title) return res.status(400).json({ error: "Falta el título" });
    const emoji = clean(req.body.emoji, 8) || "📍";
    const description = clean(req.body.description, 400);
    const location = clean(req.body.location, 120);
    const price = clean(req.body.price, 60);
    const created_by = clean(req.body.name, 40);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const { rows } = await pool.query(
      `INSERT INTO plans (title, emoji, description, location, price, color, fixed, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING id`,
      [title, emoji, description, location, price, color, created_by]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo crear el plan" });
  }
});

// Borrar una propuesta (solo no fijas)
app.delete("/api/plans/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM plans WHERE id=$1 AND fixed=false", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

// Apuntarse / quitarse de un plan (toggle)
app.post("/api/plans/:id/toggle", async (req, res) => {
  try {
    const name = clean(req.body.name, 40);
    if (!name) return res.status(400).json({ error: "Pon tu nombre primero" });
    const pid = req.params.id;
    const exists = await pool.query("SELECT 1 FROM signups WHERE plan_id=$1 AND name=$2", [pid, name]);
    if (exists.rowCount) {
      await pool.query("DELETE FROM signups WHERE plan_id=$1 AND name=$2", [pid, name]);
      res.json({ ok: true, joined: false });
    } else {
      await pool.query("INSERT INTO signups (plan_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [pid, name]);
      res.json({ ok: true, joined: true });
    }
  } catch (e) {
    res.status(500).json({ error: "No se pudo actualizar" });
  }
});

// Guardar disponibilidad de una persona (reemplaza sus días)
app.post("/api/availability", async (req, res) => {
  const c = await pool.connect();
  try {
    const name = clean(req.body.name, 40);
    if (!name) return res.status(400).json({ error: "Pon tu nombre primero" });
    const days = Array.isArray(req.body.days) ? req.body.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 200) : [];
    await c.query("BEGIN");
    await c.query("DELETE FROM availability WHERE name=$1", [name]);
    for (const d of days) {
      await c.query("INSERT INTO availability (name, day) VALUES ($1,$2) ON CONFLICT DO NOTHING", [name, d]);
    }
    await c.query("COMMIT");
    res.json({ ok: true, count: days.length });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "No se pudo guardar la disponibilidad" });
  } finally {
    c.release();
  }
});

// Crear votación
app.post("/api/polls", async (req, res) => {
  const c = await pool.connect();
  try {
    const question = clean(req.body.question, 160);
    const created_by = clean(req.body.name, 40);
    const options = (Array.isArray(req.body.options) ? req.body.options : [])
      .map((o) => clean(o, 80))
      .filter(Boolean)
      .slice(0, 12);
    if (!question || options.length < 2) return res.status(400).json({ error: "Pon una pregunta y al menos 2 opciones" });
    await c.query("BEGIN");
    const { rows } = await c.query("INSERT INTO polls (question, created_by) VALUES ($1,$2) RETURNING id", [question, created_by]);
    for (const label of options) {
      await c.query("INSERT INTO poll_options (poll_id, label) VALUES ($1,$2)", [rows[0].id, label]);
    }
    await c.query("COMMIT");
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "No se pudo crear la votación" });
  } finally {
    c.release();
  }
});

// Votar (toggle) una opción
app.post("/api/options/:id/vote", async (req, res) => {
  try {
    const name = clean(req.body.name, 40);
    if (!name) return res.status(400).json({ error: "Pon tu nombre primero" });
    const oid = req.params.id;
    const exists = await pool.query("SELECT 1 FROM poll_votes WHERE option_id=$1 AND name=$2", [oid, name]);
    if (exists.rowCount) {
      await pool.query("DELETE FROM poll_votes WHERE option_id=$1 AND name=$2", [oid, name]);
      res.json({ ok: true, voted: false });
    } else {
      await pool.query("INSERT INTO poll_votes (option_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [oid, name]);
      res.json({ ok: true, voted: true });
    }
  } catch (e) {
    res.status(500).json({ error: "No se pudo votar" });
  }
});

app.delete("/api/polls/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM polls WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log("Plan de verano escuchando en " + PORT)))
  .catch((e) => {
    console.error("Error iniciando la base de datos:", e);
    // Arranca igualmente para no caer del todo; la API devolverá errores hasta que la BD esté lista.
    app.listen(PORT, () => console.log("Servidor arriba (sin BD) en " + PORT));
  });
