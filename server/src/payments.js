// Payment providers — the one place a payment gateway plugs in (docs/SAAS.md §Payments).
//
// A provider turns a pending order into a payment page and later tells us it was paid:
//   checkout(order, ctx) → { url } to send the customer to, or { url: null, message } when there is no page
//   webhook(req)         → { orderId, paid: true, ref } from the provider's server-to-server call
//
// Today there is only "manual": no gateway — the order waits and an admin marks it paid (Admin → Orders).
// To add Paddle / Lemon Squeezy / Stripe / SSLCommerz later: add an entry here with those two functions,
// choose it in Admin → Settings → Payment provider, and point the provider's webhook at
// POST /api/public/payments/webhook/<name>. Nothing else in the app changes.
const providers = {
  manual: {
    label: 'Manual (no gateway yet)',
    ready: true,
    async checkout() {
      return { url: null, message: 'Online payment is coming soon. Your order is saved — we will contact you to complete the payment, and your credits arrive as soon as it is confirmed.' };
    },
    async webhook() {
      throw Object.assign(new Error('The manual provider has no webhook'), { status: 404 });
    },
  },
};

export const providerList = () => Object.entries(providers).map(([id, p]) => ({ id, label: p.label, ready: p.ready }));
export function provider(id) {
  return providers[id] || providers.manual;
}
