/**
 * Wedding RSVP · Cloudflare Worker
 * ─────────────────────────────────
 * GET  /api/invite?t=TOKEN  → invite + guests + existing rsvps
 * POST /api/rsvp?t=TOKEN    → upsert rsvp responses
 *
 * Security:
 *  - Token validated via SHA-256 hash lookup; raw token never stored
 *  - CORS locked to ALLOWED_ORIGINS env var
 *  - Rate limited: 10 requests per 10-minute window per token_hash
 *  - All error responses are generic (no schema/data leakage)
 */

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string; // comma-separated list
  WEDDING_DATE: string;    // YYYY-MM-DD
  DASHBOARD_PIN: string;   // secret — set via wrangler secret put DASHBOARD_PIN
}

// ── Types ──────────────────────────────────────────────────────────

interface InviteRow {
  id: number;
  token_hash: string;
  household_label: string;
  phone_e164: string;
  source_list: string;
  email: string | null;
  note: string | null;
  created_at: string;
}

interface GuestRow {
  id: number;
  invite_id: number;
  full_name: string;
  events: string; // comma-separated e.g. "welcome,ceremony,farewell"
  invited_by: string; // comma-separated e.g. "A,B,A"
}

interface RsvpRow {
  id: number;
  guest_id: number;
  event: string;
  attending: number;
  meal_choice: string | null;
  dietary_notes: string | null;
  updated_at: string;
}

interface RsvpResponse {
  guest_id: number;
  event: string;
  attending: boolean;
  meal_choice: string | null;
  dietary_notes: string | null;
}

interface RateLimitRow {
  token_hash: string;
  window_start: string;
  count: number;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Compute SHA-256 of a string, return lower-case hex. */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Validate token param: 5 uppercase alphanumeric chars (no 0/O/1/I). */
function isValidTokenShape(t: string | null): t is string {
  if (!t) return false;
  return /^[A-Z2-9]{5}$/.test(t);
}

/** Build a CORS-aware JSON response. */
function jsonResponse(
  body: unknown,
  status: number,
  corsOrigin: string | null
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    headers["Access-Control-Max-Age"] = "86400";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** Return the allowed CORS origin for this request, or null if not allowed. */
function getAllowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  // No Origin header: allow non-browser requests (curl, wrangler) but don't echo a wildcard
  if (!origin) return allowed[0] ?? null;
  return allowed.includes(origin) ? origin : null;
}

// ── Rate Limiting (D1) ─────────────────────────────────────────────

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes

async function checkRateLimit(
  db: D1Database,
  tokenHash: string
): Promise<boolean> {
  const now = new Date();
  const windowCutoff = new Date(now.getTime() - RATE_LIMIT_WINDOW_SECONDS * 1000);

  const row = await db
    .prepare("SELECT token_hash, window_start, count FROM rate_limits WHERE token_hash = ?")
    .bind(tokenHash)
    .first<RateLimitRow>();

  if (!row) {
    // First request — insert
    await db
      .prepare(
        "INSERT INTO rate_limits (token_hash, window_start, count) VALUES (?, ?, 1)"
      )
      .bind(tokenHash, now.toISOString())
      .run();
    return true;
  }

  const windowStart = new Date(row.window_start);
  if (windowStart < windowCutoff) {
    // Window expired — reset
    await db
      .prepare(
        "UPDATE rate_limits SET window_start = ?, count = 1 WHERE token_hash = ?"
      )
      .bind(now.toISOString(), tokenHash)
      .run();
    return true;
  }

  if (row.count >= RATE_LIMIT_MAX) {
    return false; // Rate limited
  }

  // Increment
  await db
    .prepare("UPDATE rate_limits SET count = count + 1 WHERE token_hash = ?")
    .bind(tokenHash)
    .run();
  return true;
}

// ── Route Handlers ─────────────────────────────────────────────────

/** GET /api/invite?t=TOKEN */
async function handleGetInvite(
  env: Env,
  tokenHash: string,
  corsOrigin: string
): Promise<Response> {
  // Rate limit
  const allowed = await checkRateLimit(env.DB, tokenHash);
  if (!allowed) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, corsOrigin);
  }

  // Lookup invite
  const invite = await env.DB
    .prepare("SELECT id, household_label, email, note FROM invites WHERE token_hash = ?")
    .bind(tokenHash)
    .first<Pick<InviteRow, "id" | "household_label" | "email" | "note">>();

  if (!invite) {
    return jsonResponse({ error: "Invalid or expired link." }, 404, corsOrigin);
  }

  // Fetch guests
  const guestRows = await env.DB
    .prepare("SELECT id, full_name, events, invited_by FROM guests WHERE invite_id = ? ORDER BY id ASC")
    .bind(invite.id)
    .all<Pick<GuestRow, "id" | "full_name" | "events" | "invited_by">>();

  const guests = guestRows.results ?? [];
  const guestIds = guests.map((g) => g.id);

  // Fetch existing RSVPs
  let rsvps: Pick<RsvpRow, "guest_id" | "event" | "attending" | "meal_choice" | "dietary_notes">[] = [];
  if (guestIds.length > 0) {
    const placeholders = guestIds.map(() => "?").join(", ");
    const rsvpRows = await env.DB
      .prepare(
        `SELECT guest_id, event, attending, meal_choice, dietary_notes FROM rsvps WHERE guest_id IN (${placeholders})`
      )
      .bind(...guestIds)
      .all<Pick<RsvpRow, "guest_id" | "event" | "attending" | "meal_choice" | "dietary_notes">>();
    rsvps = (rsvpRows.results ?? []).map((r) => ({
      ...r,
      attending: Boolean(r.attending) as unknown as number,
    }));
  }

  return jsonResponse(
    {
      household_label: invite.household_label,
      email: invite.email,
      note: invite.note,
      // Return events as array per guest
      guests: guests.map(g => {
        const evts = g.events.split(',').map(e => e.trim()).filter(Boolean);
        const ibParts = (g.invited_by ?? '').split(',').map(v => v.trim());
        const invited_by: Record<string, string> = {};
        evts.forEach((evt, i) => { invited_by[evt] = ibParts[i] || ''; });
        return { id: g.id, full_name: g.full_name, events: evts, invited_by };
      }),
      rsvps,
    },
    200,
    corsOrigin
  );
}

/** POST /api/rsvp?t=TOKEN */
async function handlePostRsvp(
  request: Request,
  env: Env,
  tokenHash: string,
  corsOrigin: string
): Promise<Response> {
  // Rate limit
  const allowed = await checkRateLimit(env.DB, tokenHash);
  if (!allowed) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, 429, corsOrigin);
  }

  // Lookup invite
  const invite = await env.DB
    .prepare("SELECT id FROM invites WHERE token_hash = ?")
    .bind(tokenHash)
    .first<Pick<InviteRow, "id">>();

  if (!invite) {
    return jsonResponse({ error: "Invalid or expired link." }, 404, corsOrigin);
  }

  // Parse body
  let body: { responses?: RsvpResponse[]; email?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  if (!Array.isArray(body.responses) || body.responses.length === 0) {
    return jsonResponse({ error: "No responses provided." }, 400, corsOrigin);
  }

  // Validate all guest_ids belong to this invite and events are valid for that guest
  const guestRows = await env.DB
    .prepare("SELECT id, events FROM guests WHERE invite_id = ?")
    .bind(invite.id)
    .all<Pick<GuestRow, "id" | "events">>();

  const validGuests = new Map((guestRows.results ?? []).map((g) => [
    g.id,
    new Set(g.events.split(',').map(e => e.trim()).filter(Boolean)),
  ]));

  const validEvents = new Set(["welcome", "ceremony", "farewell"]);

  for (const r of body.responses) {
    if (typeof r.guest_id !== "number" || !validGuests.has(r.guest_id)) {
      return jsonResponse({ error: "Invalid guest in request." }, 400, corsOrigin);
    }
    if (typeof r.event !== "string" || !validEvents.has(r.event)) {
      return jsonResponse({ error: "Invalid event." }, 400, corsOrigin);
    }
    if (!validGuests.get(r.guest_id)!.has(r.event)) {
      return jsonResponse({ error: "Guest not invited to this event." }, 403, corsOrigin);
    }
    if (typeof r.attending !== "boolean") {
      return jsonResponse({ error: "Invalid attending value." }, 400, corsOrigin);
    }
    // Validate meal_choice
    const validMeals = ["chicken", "fish", "vegetarian", "vegan", null];
    if (!validMeals.includes(r.meal_choice ?? null)) {
      return jsonResponse({ error: "Invalid meal choice." }, 400, corsOrigin);
    }
    // Clamp dietary_notes to 500 chars
    if (r.dietary_notes && r.dietary_notes.length > 500) {
      r.dietary_notes = r.dietary_notes.slice(0, 500);
    }
  }

  // Save household-level email and note
  const email = typeof body.email === 'string' ? body.email.slice(0, 200).trim() || null : null;
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000).trim() || null : null;

  // Upsert RSVPs in a batch (one per guest+event)
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  if (email !== null || note !== null) {
    stmts.push(
      env.DB.prepare("UPDATE invites SET email = ?, note = ? WHERE id = ?")
        .bind(email, note, invite.id)
    );
  }

  stmts.push(...body.responses.map((r) =>
    env.DB
      .prepare(
        `INSERT INTO rsvps (guest_id, event, attending, meal_choice, dietary_notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guest_id, event) DO UPDATE SET
           attending = excluded.attending,
           meal_choice = excluded.meal_choice,
           dietary_notes = excluded.dietary_notes,
           updated_at = excluded.updated_at`
      )
      .bind(
        r.guest_id,
        r.event,
        r.attending ? 1 : 0,
        r.meal_choice ?? null,
        r.dietary_notes ?? null,
        now
      )
  ));

  // D1 batch
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    console.error("DB batch error:", err);
    return jsonResponse({ error: "Failed to save. Please try again." }, 500, corsOrigin);
  }

  return jsonResponse({ success: true }, 200, corsOrigin);
}

/** GET /api/admin/rsvps — protected by DASHBOARD_PIN secret */
async function handleGetAdminRsvps(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  const rows = await env.DB
    .prepare(`
      SELECT
        i.household_label,
        i.phone_e164,
        i.id as invite_id,
        i.source_list,
        i.email,
        i.note,
        g.id as guest_id,
        g.full_name,
        g.events as invited_events,
        g.invited_by,
        r.event,
        CASE WHEN r.attending = 1 THEN 'YES' WHEN r.attending = 0 THEN 'NO' ELSE NULL END as attending,
        r.updated_at
      FROM guests g
      JOIN invites i ON i.id = g.invite_id
      LEFT JOIN rsvps r ON r.guest_id = g.id
      ORDER BY i.household_label, g.full_name, r.event
    `)
    .all();

  return jsonResponse({ rsvps: rows.results ?? [] }, 200, corsOrigin);
}
/** PATCH /api/admin/rsvp — manually set or clear a guest+event response */
async function handlePatchAdminRsvp(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  let body: { guest_id?: number; event?: string; attending?: boolean | null };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  const { guest_id, event, attending } = body;
  if (typeof guest_id !== "number" || typeof event !== "string") {
    return jsonResponse({ error: "guest_id and event are required." }, 400, corsOrigin);
  }
  const validEvents = new Set(["welcome", "ceremony", "farewell"]);
  if (!validEvents.has(event)) {
    return jsonResponse({ error: "Invalid event." }, 400, corsOrigin);
  }

  // attending === null means delete (reset to pending)
  if (attending === null || attending === undefined) {
    await env.DB.prepare("DELETE FROM rsvps WHERE guest_id = ? AND event = ?")
      .bind(guest_id, event).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO rsvps (guest_id, event, attending, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guest_id, event) DO UPDATE SET
         attending = excluded.attending,
         updated_at = excluded.updated_at`
    ).bind(guest_id, event, attending ? 1 : 0, new Date().toISOString()).run();
  }

  return jsonResponse({ success: true }, 200, corsOrigin);
}
/** POST /api/admin/household — create a new household with first guest */
async function handlePostAdminHousehold(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  let body: {
    household_label?: string; source_list?: string;
    guests?: { full_name: string; events: string; invited_by?: string }[];
    // Legacy single-guest fields (still supported)
    full_name?: string; events?: string; invited_by?: string;
  };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  const { household_label, source_list } = body;
  if (typeof household_label !== "string") {
    return jsonResponse({ error: "household_label is required." }, 400, corsOrigin);
  }

  const trimmedLabel = household_label.trim().slice(0, 100);
  if (!trimmedLabel) return jsonResponse({ error: "household_label cannot be empty." }, 400, corsOrigin);

  // Support both single guest (legacy) and multiple guests
  const guestList = body.guests ?? (body.full_name ? [{ full_name: body.full_name, events: body.events!, invited_by: body.invited_by }] : []);
  if (guestList.length === 0) return jsonResponse({ error: "At least one guest is required." }, 400, corsOrigin);

  const validEvents = new Set(["welcome", "ceremony", "farewell"]);
  const validated: { name: string; events: string; ib: string | null }[] = [];

  for (const g of guestList) {
    const name = (g.full_name ?? "").trim().slice(0, 100);
    if (!name) return jsonResponse({ error: "Guest name cannot be empty." }, 400, corsOrigin);
    const evtList = (g.events ?? "").split(",").map(e => e.trim()).filter(Boolean);
    if (evtList.length === 0 || !evtList.every(e => validEvents.has(e))) {
      return jsonResponse({ error: `Invalid events for ${name}.` }, 400, corsOrigin);
    }
    const ibParts = (g.invited_by ?? "").split(",").map(v => v.trim()).filter(Boolean);
    if (ibParts.length > 0 && (ibParts.length !== evtList.length || !ibParts.every(v => v === "A" || v === "B"))) {
      return jsonResponse({ error: `Invalid invited_by for ${name}.` }, 400, corsOrigin);
    }
    validated.push({ name, events: evtList.join(","), ib: ibParts.join(",") || null });
  }

  const validSources = new Set(["A", "B"]);
  const src = validSources.has(source_list ?? "") ? source_list! : null;

  // Check for duplicate household + guest combination
  const dupeCheck = await env.DB.prepare(
    `SELECT g.full_name, g.events, g.invited_by, i.household_label, i.source_list
     FROM invites i JOIN guests g ON g.invite_id = i.id
     WHERE LOWER(i.household_label) = ?`
  ).bind(trimmedLabel.toLowerCase()).all();
  const dupeResults = dupeCheck.results ?? [];
  if (dupeResults.length > 0 && !(body as any).force) {
    return jsonResponse({
      error: "duplicate",
      message: `A household "${trimmedLabel}" already exists.`,
      existing: dupeResults.map((r: any) => ({ full_name: r.full_name, events: r.events, invited_by: r.invited_by, source_list: r.source_list }))
    }, 409, corsOrigin);
  }

  // Generate token
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let token = "";
  const rng = new Uint8Array(5);
  crypto.getRandomValues(rng);
  for (let i = 0; i < 5; i++) token += chars[rng[i] % chars.length];
  const tokenHash = await sha256Hex(token);

  // Find next placeholder phone
  const maxPhone = await env.DB.prepare(
    "SELECT phone_e164 FROM invites WHERE phone_e164 LIKE '+1000000%' ORDER BY phone_e164 DESC LIMIT 1"
  ).first<{ phone_e164: string }>();
  const nextNum = maxPhone ? parseInt(maxPhone.phone_e164.slice(1)) + 1 : 10000000001;
  const phone = `+${nextNum}`;

  const invResult = await env.DB.prepare(
    "INSERT INTO invites (token_hash, household_label, phone_e164, source_list) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, trimmedLabel, phone, src).run();

  const inviteId = invResult.meta.last_row_id;
  const guestStmts = validated.map(g =>
    env.DB.prepare("INSERT INTO guests (invite_id, full_name, events, invited_by) VALUES (?, ?, ?, ?)")
      .bind(inviteId, g.name, g.events, g.ib)
  );
  await env.DB.batch(guestStmts);

  return jsonResponse({ success: true, invite_id: inviteId, token, phone }, 200, corsOrigin);
}

/** POST /api/admin/guest — add a guest to an existing household */
async function handlePostAdminGuest(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  let body: { invite_id?: number; full_name?: string; events?: string; invited_by?: string };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  const { invite_id, full_name, events, invited_by } = body;
  if (typeof invite_id !== "number" || typeof full_name !== "string" || typeof events !== "string") {
    return jsonResponse({ error: "invite_id, full_name, and events are required." }, 400, corsOrigin);
  }

  const trimmedName = full_name.trim().slice(0, 100);
  if (!trimmedName) return jsonResponse({ error: "full_name cannot be empty." }, 400, corsOrigin);

  const validEvents = new Set(["welcome", "ceremony", "farewell"]);
  const evtList = events.split(",").map(e => e.trim()).filter(Boolean);
  if (evtList.length === 0 || !evtList.every(e => validEvents.has(e))) {
    return jsonResponse({ error: "Invalid events." }, 400, corsOrigin);
  }

  const ibParts = (invited_by ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (ibParts.length > 0 && (ibParts.length !== evtList.length || !ibParts.every(v => v === "A" || v === "B"))) {
    return jsonResponse({ error: "invited_by must match events count with A or B values." }, 400, corsOrigin);
  }

  // Verify invite exists
  const inv = await env.DB.prepare("SELECT id FROM invites WHERE id = ?").bind(invite_id).first();
  if (!inv) return jsonResponse({ error: "Invite not found." }, 404, corsOrigin);

  const result = await env.DB.prepare(
    "INSERT INTO guests (invite_id, full_name, events, invited_by) VALUES (?, ?, ?, ?)"
  ).bind(invite_id, trimmedName, evtList.join(","), ibParts.join(",") || null).run();

  return jsonResponse({ success: true, guest_id: result.meta.last_row_id }, 200, corsOrigin);
}

/** DELETE /api/admin/guest — remove a guest */
async function handleDeleteAdminGuest(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  let body: { guest_id?: number };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  if (typeof body.guest_id !== "number") {
    return jsonResponse({ error: "guest_id is required." }, 400, corsOrigin);
  }

  const guest = await env.DB.prepare("SELECT id FROM guests WHERE id = ?").bind(body.guest_id).first();
  if (!guest) return jsonResponse({ error: "Guest not found." }, 404, corsOrigin);

  // ON DELETE CASCADE handles rsvps
  await env.DB.prepare("DELETE FROM guests WHERE id = ?").bind(body.guest_id).run();

  return jsonResponse({ success: true }, 200, corsOrigin);
}

/** PATCH /api/admin/guest — modify guest name, events, or invited_by */
async function handlePatchAdminGuest(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  let body: { guest_id?: number; full_name?: string; events?: string; invited_by?: string };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  if (typeof body.guest_id !== "number") {
    return jsonResponse({ error: "guest_id is required." }, 400, corsOrigin);
  }

  const guest = await env.DB.prepare("SELECT id, events FROM guests WHERE id = ?")
    .bind(body.guest_id).first<Pick<GuestRow, "id" | "events">>();
  if (!guest) return jsonResponse({ error: "Guest not found." }, 404, corsOrigin);

  const sets: string[] = [];
  const vals: (string | number)[] = [];
  const validEvents = new Set(["welcome", "ceremony", "farewell"]);

  if (typeof body.full_name === "string") {
    const trimmed = body.full_name.trim().slice(0, 100);
    if (!trimmed) return jsonResponse({ error: "full_name cannot be empty." }, 400, corsOrigin);
    sets.push("full_name = ?");
    vals.push(trimmed);
  }

  let newEvtList: string[] | null = null;
  if (typeof body.events === "string") {
    newEvtList = body.events.split(",").map(e => e.trim()).filter(Boolean);
    if (newEvtList.length === 0 || !newEvtList.every(e => validEvents.has(e))) {
      return jsonResponse({ error: "Invalid events." }, 400, corsOrigin);
    }
    sets.push("events = ?");
    vals.push(newEvtList.join(","));
  }

  if (typeof body.invited_by === "string") {
    const ibParts = body.invited_by.split(",").map(v => v.trim()).filter(Boolean);
    const evtCount = newEvtList ? newEvtList.length : guest.events.split(",").filter(Boolean).length;
    if (ibParts.length !== evtCount || !ibParts.every(v => v === "A" || v === "B")) {
      return jsonResponse({ error: "invited_by must match events count with A or B values." }, 400, corsOrigin);
    }
    sets.push("invited_by = ?");
    vals.push(ibParts.join(","));
  }

  if (sets.length === 0) {
    return jsonResponse({ error: "No fields to update." }, 400, corsOrigin);
  }

  vals.push(body.guest_id);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE guests SET ${sets.join(", ")} WHERE id = ?`).bind(...vals)
  ];

  // Clean up orphaned rsvps if events changed
  if (newEvtList) {
    const placeholders = newEvtList.map(() => "?").join(",");
    stmts.push(
      env.DB.prepare(`DELETE FROM rsvps WHERE guest_id = ? AND event NOT IN (${placeholders})`)
        .bind(body.guest_id, ...newEvtList)
    );
  }

  await env.DB.batch(stmts);
  return jsonResponse({ success: true }, 200, corsOrigin);
}

/** POST /api/admin/regenerate-token — generate a new RSVP code for a household */
async function handleRegenerateToken(
  request: Request,
  env: Env,
  corsOrigin: string
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const pin = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!pin || pin !== env.DASHBOARD_PIN) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsOrigin);
  }

  let body: { invite_id?: number };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid request body." }, 400, corsOrigin);
  }

  if (typeof body.invite_id !== "number") {
    return jsonResponse({ error: "invite_id is required." }, 400, corsOrigin);
  }

  const invite = await env.DB.prepare("SELECT id, household_label FROM invites WHERE id = ?")
    .bind(body.invite_id).first<{ id: number; household_label: string }>();
  if (!invite) return jsonResponse({ error: "Invite not found." }, 404, corsOrigin);

  // Generate new token
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let token = "";
  const rng = new Uint8Array(5);
  crypto.getRandomValues(rng);
  for (let i = 0; i < 5; i++) token += chars[rng[i] % chars.length];
  const tokenHash = await sha256Hex(token);

  await env.DB.prepare("UPDATE invites SET token_hash = ? WHERE id = ?")
    .bind(tokenHash, body.invite_id).run();

  return jsonResponse({ success: true, token, household_label: invite.household_label }, 200, corsOrigin);
}

// ── Main Handler ───────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS origin check
    const corsOrigin = getAllowedOrigin(request, env);

    // ── Handle CORS preflight
    if (request.method === "OPTIONS") {
      if (corsOrigin) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // ── Reject non-allowed origins for actual requests
    if (!corsOrigin) {
      return new Response("Forbidden", { status: 403 });
    }

    // ── Route: GET /api/invite
    if (path === "/api/invite" && request.method === "GET") {
      const tokenParam = url.searchParams.get("t");
      if (!isValidTokenShape(tokenParam)) {
        return jsonResponse({ error: "Invalid or expired link." }, 400, corsOrigin);
      }
      const tokenHash = await sha256Hex(tokenParam);
      return handleGetInvite(env, tokenHash, corsOrigin);
    }

    // ── Route: POST /api/rsvp
    if (path === "/api/rsvp" && request.method === "POST") {
      const tokenParam = url.searchParams.get("t");
      if (!isValidTokenShape(tokenParam)) {
        return jsonResponse({ error: "Invalid or expired link." }, 400, corsOrigin);
      }
      const tokenHash = await sha256Hex(tokenParam);
      return handlePostRsvp(request, env, tokenHash, corsOrigin);
    }

    // ── Route: GET /api/admin/rsvps
    if (path === "/api/admin/rsvps" && request.method === "GET") {
      return handleGetAdminRsvps(request, env, corsOrigin);
    }

    // ── Route: PATCH /api/admin/rsvp
    if (path === "/api/admin/rsvp" && request.method === "PATCH") {
      return handlePatchAdminRsvp(request, env, corsOrigin);
    }

    // ── Route: POST /api/admin/household
    if (path === "/api/admin/household" && request.method === "POST") {
      return handlePostAdminHousehold(request, env, corsOrigin);
    }

    // ── Route: POST /api/admin/guest
    if (path === "/api/admin/guest" && request.method === "POST") {
      return handlePostAdminGuest(request, env, corsOrigin);
    }

    // ── Route: DELETE /api/admin/guest
    if (path === "/api/admin/guest" && request.method === "DELETE") {
      return handleDeleteAdminGuest(request, env, corsOrigin);
    }

    // ── Route: PATCH /api/admin/guest
    if (path === "/api/admin/guest" && request.method === "PATCH") {
      return handlePatchAdminGuest(request, env, corsOrigin);
    }

    // ── Route: POST /api/admin/regenerate-token
    if (path === "/api/admin/regenerate-token" && request.method === "POST") {
      return handleRegenerateToken(request, env, corsOrigin);
    }

    // ── 404 for everything else
    return jsonResponse({ error: "Not found." }, 404, corsOrigin);
  },
};
