import { Router } from "express";
import { getSupabase } from "../lib/supabase.js";

export const messagesRouter = Router();

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conversationId(a: string, b: string): string {
  return [a, b].sort().join(":");
}

// POST /v1/messages — send a message
messagesRouter.post("/", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Messages store not configured" });
    return;
  }

  const { sender_address, recipient_address, content } = req.body ?? {};

  if (
    !sender_address || !EVM_ADDR.test(String(sender_address)) ||
    !recipient_address || !EVM_ADDR.test(String(recipient_address))
  ) {
    res.status(400).json({ error: "sender_address and recipient_address must be valid Arc EVM addresses (0x…)" });
    return;
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  if (sender_address === recipient_address) {
    res.status(400).json({ error: "Cannot message yourself" });
    return;
  }

  const convId = conversationId(sender_address, recipient_address);

  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: convId,
      sender_address: String(sender_address),
      recipient_address: String(recipient_address),
      content: content.trim().slice(0, 4000),
    })
    .select("id, created_at")
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({ id: data.id, created_at: data.created_at });
});

// GET /v1/messages/conversation?a=ADDR1&b=ADDR2&since=ISO — fetch chat thread
messagesRouter.get("/conversation", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ messages: [] });
    return;
  }

  const a = String(req.query.a ?? "").trim();
  const b = String(req.query.b ?? "").trim();
  const since = String(req.query.since ?? "").trim();

  if (!EVM_ADDR.test(a) || !EVM_ADDR.test(b)) {
    res.status(400).json({ error: "a and b must be valid Arc EVM addresses (0x…)" });
    return;
  }

  const convId = conversationId(a, b);
  let query = supabase
    .from("messages")
    .select("id, sender_address, recipient_address, content, read_at, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (since) {
    query = query.gt("created_at", since);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ messages: data ?? [] });
});

// GET /v1/messages/inbox?wallet=ADDR — list all conversations with latest message + unread count
messagesRouter.get("/inbox", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ conversations: [] });
    return;
  }

  const wallet = String(req.query.wallet ?? "").trim();
  if (!EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }

  // Fetch messages where user is sender OR recipient, ordered by newest first
  const { data, error } = await supabase
    .from("messages")
    .select("id, conversation_id, sender_address, recipient_address, content, read_at, created_at")
    .or(`sender_address.eq.${wallet},recipient_address.eq.${wallet}`)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Group by conversation, keep latest message + unread count
  const convMap = new Map<string, {
    conversation_id: string;
    other_address: string;
    latest_message: string;
    latest_at: string;
    unread: number;
  }>();

  for (const row of data ?? []) {
    const other = row.sender_address === wallet ? row.recipient_address : row.sender_address;
    if (!convMap.has(row.conversation_id)) {
      convMap.set(row.conversation_id, {
        conversation_id: row.conversation_id,
        other_address: other,
        latest_message: row.content,
        latest_at: row.created_at,
        unread: 0,
      });
    }
    // Count unread: messages sent TO this wallet that have no read_at
    if (row.recipient_address === wallet && !row.read_at) {
      const entry = convMap.get(row.conversation_id)!;
      entry.unread++;
    }
  }

  res.json({ conversations: Array.from(convMap.values()) });
});

// GET /v1/messages/unread-count?wallet=ADDR — total unread count for badge
messagesRouter.get("/unread-count", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.json({ count: 0 });
    return;
  }

  const wallet = String(req.query.wallet ?? "").trim();
  if (!EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }

  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("recipient_address", wallet)
    .is("read_at", null);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ count: count ?? 0 });
});

// PATCH /v1/messages/conversation/read?a=ADDR1&b=ADDR2&wallet=ADDR — mark all messages in thread as read
messagesRouter.patch("/conversation/read", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Messages store not configured" });
    return;
  }

  const a = String(req.query.a ?? "").trim();
  const b = String(req.query.b ?? "").trim();
  const wallet = String(req.query.wallet ?? "").trim();

  if (!EVM_ADDR.test(a) || !EVM_ADDR.test(b) || !EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "a, b, and wallet must be valid Arc EVM addresses (0x…)" });
    return;
  }

  const convId = conversationId(a, b);
  const { error } = await supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("conversation_id", convId)
    .eq("recipient_address", wallet)
    .is("read_at", null);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ ok: true });
});

// PATCH /v1/messages/:id/read?wallet=ADDR — mark single message as read
messagesRouter.patch("/:id/read", async (req, res) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ error: "Messages store not configured" });
    return;
  }

  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid message id" });
    return;
  }

  const wallet = String(req.query.wallet ?? "").trim();
  if (!EVM_ADDR.test(wallet)) {
    res.status(400).json({ error: "wallet must be a valid Arc EVM address (0x…)" });
    return;
  }

  const { error } = await supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("recipient_address", wallet)
    .is("read_at", null);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ ok: true });
});
