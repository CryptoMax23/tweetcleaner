// ─── OAuth 1.0a helpers ───────────────────────────────────────────────────────

async function hmacSha1(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function buildOAuthHeader(method, url, extraParams, consumerKey, consumerSecret, token = '', tokenSecret = '') {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const ts = Math.floor(Date.now() / 1000).toString();

  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: ts,
    oauth_version: '1.0',
    ...extraParams,
  };
  if (token) params.oauth_token = token;

  const paramStr = Object.entries(params)
    .sort(([a], [b]) => pct(a) < pct(b) ? -1 : 1)
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join('&');

  const baseStr = `${method}&${pct(url)}&${pct(paramStr)}`;
  const sigKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  params.oauth_signature = await hmacSha1(sigKey, baseStr);

  return 'OAuth ' + Object.entries(params)
    .filter(([k]) => k.startsWith('oauth_'))
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(', ');
}

// ─── Twitter API ──────────────────────────────────────────────────────────────

async function twitterRequestToken(env, callbackUrl) {
  const url = 'https://api.twitter.com/oauth/request_token';
  const auth = await buildOAuthHeader('POST', url, { oauth_callback: callbackUrl },
    env.CONSUMER_KEY, env.CONSUMER_SECRET);
  const res = await fetch(url, { method: 'POST', headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`request_token failed: ${res.status} ${await res.text()}`);
  return Object.fromEntries(new URLSearchParams(await res.text()));
}

async function twitterAccessToken(env, oauthToken, oauthTokenSecret, verifier) {
  const url = 'https://api.twitter.com/oauth/access_token';
  const auth = await buildOAuthHeader('POST', url, { oauth_verifier: verifier },
    env.CONSUMER_KEY, env.CONSUMER_SECRET, oauthToken, oauthTokenSecret);
  const res = await fetch(url, { method: 'POST', headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`access_token failed: ${res.status} ${await res.text()}`);
  return Object.fromEntries(new URLSearchParams(await res.text()));
}

async function twitterDeleteTweet(env, accessToken, accessSecret, tweetId) {
  const url = `https://api.twitter.com/1.1/statuses/destroy/${tweetId}.json`;
  const params = { id: tweetId };
  const auth = await buildOAuthHeader('POST', url, params,
    env.CONSUMER_KEY, env.CONSUMER_SECRET, accessToken, accessSecret);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.text();
  return { status: res.status, body };
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function getSession(env, sessionId) {
  if (!sessionId) return null;
  const raw = await env.SESSIONS.get(`sess:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleAuthStart(request, env) {
  const origin = new URL(request.url).origin;
  try {
    const tokens = await twitterRequestToken(env, `${origin}/auth/callback`);
    await env.SESSIONS.put(`req:${tokens.oauth_token}`, tokens.oauth_token_secret, { expirationTtl: 600 });
    return Response.redirect(`https://api.twitter.com/oauth/authorize?oauth_token=${tokens.oauth_token}`, 302);
  } catch (e) {
    return new Response(`Erreur OAuth : ${e.message}`, { status: 500 });
  }
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const oauthToken = url.searchParams.get('oauth_token');
  const verifier = url.searchParams.get('oauth_verifier');

  if (!oauthToken || !verifier) {
    return new Response('Paramètres OAuth manquants', { status: 400 });
  }

  const requestSecret = await env.SESSIONS.get(`req:${oauthToken}`);
  if (!requestSecret) return new Response('Session expirée, recommencez', { status: 400 });

  try {
    const tokens = await twitterAccessToken(env, oauthToken, requestSecret, verifier);
    const sessionId = crypto.randomUUID();
    await env.SESSIONS.put(`sess:${sessionId}`, JSON.stringify({
      accessToken: tokens.oauth_token,
      accessSecret: tokens.oauth_token_secret,
      screenName: tokens.screen_name,
    }), { expirationTtl: 86400 * 30 });

    return Response.redirect(`${url.origin}/?session=${sessionId}`, 302);
  } catch (e) {
    return new Response(`Erreur callback OAuth : ${e.message}`, { status: 500 });
  }
}

// ─── Plan helpers ─────────────────────────────────────────────────────────────

const FREE_LIMIT = 50;

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getUserPlan(env, screenName) {
  const raw = await env.SESSIONS.get(`plan:${screenName}`);
  if (!raw) return { plan: 'free' };
  const data = JSON.parse(raw);
  if (data.expiresAt && Date.now() > data.expiresAt) return { plan: 'free' };
  return data;
}

async function getUsage(env, screenName) {
  const val = await env.SESSIONS.get(`usage:${screenName}:${monthKey()}`);
  return parseInt(val || '0');
}

async function incrementUsage(env, screenName, count) {
  const key = `usage:${screenName}:${monthKey()}`;
  const current = parseInt(await env.SESSIONS.get(key) || '0');
  await env.SESSIONS.put(key, String(current + count), { expirationTtl: 86400 * 35 });
  return current + count;
}

// ─── Stripe helpers ───────────────────────────────────────────────────────────

const STRIPE_PRICES = {
  pro:     'STRIPE_PRICE_PRO_ID',
  premium: 'STRIPE_PRICE_PREMIUM_ID',
};

async function createCheckoutSession(env, priceId, screenName, successUrl, cancelUrl) {
  const body = new URLSearchParams({
    'line_items[0][price]':    priceId,
    'line_items[0][quantity]': '1',
    mode:        'subscription',
    success_url: successUrl,
    cancel_url:  cancelUrl,
    'subscription_data[metadata][screenName]': screenName,
    'metadata[screenName]': screenName,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  return res.json();
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleApiMe(request, env) {
  const sessionId = new URL(request.url).searchParams.get('session');
  const session = await getSession(env, sessionId);
  if (!session) return jsonResponse({ error: 'Non connecté' }, 401);
  return jsonResponse({ username: session.screenName });
}

async function handleApiPlan(request, env) {
  const sessionId = new URL(request.url).searchParams.get('session');
  const session = await getSession(env, sessionId);
  if (!session) return jsonResponse({ error: 'Non connecté' }, 401);
  const { plan } = await getUserPlan(env, session.screenName);
  const usage = await getUsage(env, session.screenName);
  return jsonResponse({ plan, usage });
}

async function handleApiDelete(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const { session: sessionId, ids } = await request.json();
  const session = await getSession(env, sessionId);
  if (!session) return jsonResponse({ error: 'Session invalide' }, 401);
  if (!Array.isArray(ids) || ids.length === 0) return jsonResponse({ error: 'Aucun ID fourni' }, 400);

  const { plan } = await getUserPlan(env, session.screenName);

  // Check free plan monthly limit
  if (plan === 'free') {
    const usage = await getUsage(env, session.screenName);
    if (usage >= FREE_LIMIT) return jsonResponse({ deleted: 0, limitReached: true });
  }

  let deleted = 0;
  const errors = [];

  for (const id of ids) {
    if (plan === 'free') {
      const usage = await getUsage(env, session.screenName);
      if (usage >= FREE_LIMIT) return jsonResponse({ deleted, limitReached: true });
    }

    const { status, body } = await twitterDeleteTweet(env, session.accessToken, session.accessSecret, id);
    if (status === 200) {
      deleted++;
      if (plan === 'free') await incrementUsage(env, session.screenName, 1);
    } else if (status === 404) {
      errors.push({ id, status: 'already_gone' });
    } else if (status === 429) {
      return jsonResponse({ deleted, rateLimited: true });
    } else {
      errors.push({ id, status, body });
      if (errors.length === 1) return jsonResponse({ deleted, errors });
    }
  }

  if (plan !== 'free') await incrementUsage(env, session.screenName, deleted);
  return jsonResponse({ deleted, errors });
}

async function handleApiCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY.startsWith('STRIPE_')) {
    return jsonResponse({ error: 'Stripe non configuré — ajoutez STRIPE_SECRET_KEY via wrangler secret put' }, 500);
  }
  const { session: sessionId, plan } = await request.json();
  const session = await getSession(env, sessionId);
  if (!session) return jsonResponse({ error: 'Non connecté' }, 401);

  const priceId = plan === 'pro' ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_PREMIUM;
  if (!priceId) return jsonResponse({ error: `Prix Stripe pour "${plan}" non configuré` }, 500);

  const origin = new URL(request.url).origin;
  const checkout = await createCheckoutSession(env, priceId, session.screenName, `${origin}/?success=1`, `${origin}/?cancelled=1`);

  if (checkout.error) return jsonResponse({ error: `Stripe: ${checkout.error.message} (code: ${checkout.error.code || 'n/a'})` }, 500);
  if (!checkout.url) return jsonResponse({ error: `Stripe n'a pas retourné d'URL. Réponse: ${JSON.stringify(checkout)}` }, 500);
  return jsonResponse({ url: checkout.url });
}

async function handleStripeWebhook(request, env) {
  const body = await request.text();
  // Verify signature in production — simplifié ici
  try {
    const event = JSON.parse(body);
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const screenName = sub.metadata?.screenName;
      const plan = sub.items?.data?.[0]?.price?.id === env.STRIPE_PRICE_PREMIUM ? 'premium' : 'pro';
      if (screenName) {
        await env.SESSIONS.put(`plan:${screenName}`, JSON.stringify({
          plan, stripeSubscriptionId: sub.id,
          expiresAt: sub.current_period_end * 1000,
        }), { expirationTtl: 86400 * 40 });
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const screenName = event.data.object.metadata?.screenName;
      if (screenName) await env.SESSIONS.delete(`plan:${screenName}`);
    }
  } catch(e) {}
  return new Response('ok');
}

async function handleAuthDirect(request, env) {
  if (!env.ACCESS_TOKEN || !env.ACCESS_TOKEN_SECRET) {
    return jsonResponse({ error: 'Tokens non configurés' }, 500);
  }
  const sessionId = 'direct-jordandebelfort';
  await env.SESSIONS.put(`sess:${sessionId}`, JSON.stringify({
    accessToken: env.ACCESS_TOKEN,
    accessSecret: env.ACCESS_TOKEN_SECRET,
    screenName: 'jordandebelfort',
  }), { expirationTtl: 86400 * 365 });
  return jsonResponse({ session: sessionId, username: 'jordandebelfort' });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/auth/start')      return handleAuthStart(request, env);
    if (pathname === '/auth/callback')   return handleAuthCallback(request, env);
    if (pathname === '/auth/direct')     return handleAuthDirect(request, env);
    if (pathname === '/api/me')          return handleApiMe(request, env);
    if (pathname === '/api/plan')        return handleApiPlan(request, env);
    if (pathname === '/api/delete')      return handleApiDelete(request, env);
    if (pathname === '/api/checkout')    return handleApiCheckout(request, env);
    if (pathname === '/webhook/stripe')  return handleStripeWebhook(request, env);
    if (pathname === '/api/test-delete') {
      const id = new URL(request.url).searchParams.get('id') || '2069791272177414481';
      const { status, body } = await twitterDeleteTweet(env, env.ACCESS_TOKEN, env.ACCESS_TOKEN_SECRET, id);
      return jsonResponse({ status, body });
    }
    if (pathname === '/api/verify') {
      const url = 'https://api.twitter.com/1.1/account/verify_credentials.json';
      const auth = await buildOAuthHeader('GET', url, {}, env.CONSUMER_KEY, env.CONSUMER_SECRET, env.ACCESS_TOKEN, env.ACCESS_TOKEN_SECRET);
      const res = await fetch(url, { headers: { Authorization: auth } });
      const data = await res.json();
      return jsonResponse({ status: res.status, screen_name: data.screen_name, id_str: data.id_str, error: data.errors });
    }

    return env.ASSETS.fetch(request);
  },
};
