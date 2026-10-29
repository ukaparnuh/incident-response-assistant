// Loaded from config.js (copy config.example.js and fill in your values).
const SHOP_CONFIG = window.SHOP_CONFIG || {};
const CONFIG = {
  ...SHOP_CONFIG,
  webhookUrl: `${SHOP_CONFIG.apiBase}/alerts`,
};

const PRODUCTS = [
  { id: 1, name: "Laptop Sleeve", price: 1200, icon: "💼", blurb: "Padded everyday protection for your laptop." },
  { id: 2, name: "Wireless Mouse", price: 800, icon: "🖱️", blurb: "Compact, quiet and easy on the wrist." },
  { id: 3, name: "Mechanical Keyboard", price: 3500, icon: "⌨️", blurb: "Tactile switches for long typing sessions." },
  { id: 4, name: "USB-C Hub", price: 2200, icon: "🔌", blurb: "Expand one port into a full desk setup." },
];

const productList = document.getElementById("product-list");
const productCount = document.getElementById("product-count");
const cartItemsDiv = document.getElementById("cart-items");
const cartTotalSpan = document.getElementById("cart-total");
const cartCountSpan = document.getElementById("cart-count");
const checkoutBtn = document.getElementById("checkout-btn");
const failToggle = document.getElementById("fail-toggle");
const statusDiv = document.getElementById("status");
const dashboardLink = document.getElementById("dashboard-link");
const updatesPanel = document.getElementById("updates");
const updatesList = document.getElementById("updates-list");

const TRACKED_KEY = "mini-shop-incidents";
const POLL_MS = 5000;
const UPDATE_TEXT = {
  queued: { label: "Received", note: "Your report was received and is being analysed." },
  open: { label: "Received", note: "Your report is in the queue. An engineer will pick it up shortly." },
  acknowledged: { label: "Investigating", note: "An engineer is investigating this checkout failure." },
  resolved: { label: "Resolved", note: "This checkout failure has been fixed." },
};

let cart = [];
let tracked = loadTracked();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function money(amount) {
  return "₹" + amount.toLocaleString("en-IN");
}

function cartLines() {
  return cart.map((line) => ({ ...PRODUCTS.find((p) => p.id === line.id), qty: line.qty }));
}

function cartTotal() {
  return cartLines().reduce((sum, line) => sum + line.price * line.qty, 0);
}

function cartCount() {
  return cart.reduce((sum, line) => sum + line.qty, 0);
}

function renderProducts() {
  productCount.textContent = `${PRODUCTS.length} items`;
  productList.replaceChildren(
    ...PRODUCTS.map((product) => {
      const card = el("article", "product");
      const art = el("div", "art", product.icon);
      const body = el("div", "product-body");
      const foot = el("div", "product-foot");
      const button = el("button", "btn-add", "Add to cart");

      body.append(el("h3", "", product.name), el("p", "muted", product.blurb));
      foot.append(el("span", "price", money(product.price)), button);
      body.append(foot);
      card.append(art, body);

      button.addEventListener("click", () => addToCart(product.id));
      return card;
    })
  );
}

function addToCart(id) {
  const line = cart.find((l) => l.id === id);
  if (line) {
    line.qty += 1;
  } else {
    cart.push({ id, qty: 1 });
  }
  renderCart();
}

function changeQty(id, delta) {
  const line = cart.find((l) => l.id === id);
  if (!line) return;
  line.qty += delta;
  cart = cart.filter((l) => l.qty > 0);
  renderCart();
}

function removeLine(id) {
  cart = cart.filter((l) => l.id !== id);
  renderCart();
}

function renderCart() {
  const lines = cartLines();
  cartItemsDiv.replaceChildren();

  if (lines.length === 0) {
    cartItemsDiv.append(el("div", "cart-empty", "Your cart is empty. Add something you like."));
  }

  lines.forEach((line) => {
    const row = el("div", "cart-item");

    const info = el("div", "cart-info");
    info.append(el("span", "cart-name", line.name), el("span", "muted", `${money(line.price)} each`));

    const qty = el("div", "qty");
    const minus = el("button", "qty-btn", "−");
    const count = el("span", "qty-count", String(line.qty));
    const plus = el("button", "qty-btn", "+");
    minus.setAttribute("aria-label", `Decrease ${line.name}`);
    plus.setAttribute("aria-label", `Increase ${line.name}`);
    minus.addEventListener("click", () => changeQty(line.id, -1));
    plus.addEventListener("click", () => changeQty(line.id, 1));
    qty.append(minus, count, plus);

    const lineTotal = el("strong", "", money(line.price * line.qty));
    const remove = el("button", "remove", "Remove");
    remove.addEventListener("click", () => removeLine(line.id));

    row.append(info, lineTotal, qty, remove);
    cartItemsDiv.append(row);
  });

  cartTotalSpan.textContent = money(cartTotal());
  const count = cartCount();
  cartCountSpan.textContent = `${count} ${count === 1 ? "item" : "items"}`;
}

function showStatus(kind, title, detail, incidentId) {
  statusDiv.className = `status ${kind}`;
  statusDiv.replaceChildren(el("strong", "", title));

  if (detail) statusDiv.append(el("p", "", detail));

  if (incidentId) {
    statusDiv.append(el("code", "incident-id", `Incident ID: ${incidentId}`));
  }

  if (incidentId && CONFIG.dashboardUrl) {
    const link = el("a", "", "View in incident dashboard →");
    link.href = CONFIG.dashboardUrl;
    link.target = "_blank";
    link.rel = "noopener";
    statusDiv.append(link);
  }
}

async function sendIncidentAlert(errorMessage) {
  const payload = {
    source: "mini-shop-demo",
    title: "Checkout API 500 error in demo store",
    description: errorMessage,
    service: "checkout-service",
    severity_hint: "high",
  };

  let response;
  try {
    response = await fetch(CONFIG.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error("the request never reached the incident API. Check your network and the API URL.");
  }

  if (!response.ok) {
    const reason = response.status === 403 ? "the API key was rejected" : "the API returned an error";
    throw new Error(`${reason} (HTTP ${response.status}).`);
  }

  return response.json();
}

function loadTracked() {
  try {
    return JSON.parse(localStorage.getItem(TRACKED_KEY)) || [];
  } catch (err) {
    return [];
  }
}

function saveTracked() {
  localStorage.setItem(TRACKED_KEY, JSON.stringify(tracked.slice(0, 10)));
}

function trackIncident(incidentId) {
  const entry = { incident_id: incidentId, status: "queued", created_at: new Date().toISOString() };
  tracked = [entry, ...tracked.filter((t) => t.incident_id !== incidentId)];
  saveTracked();
  renderUpdates();
  refreshUpdates();
}

function notify(message) {
  const toast = el("div", "toast", message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 6000);
}

async function fetchUpdate(item) {
  const previous = item.status;
  try {
    const res = await fetch(`${CONFIG.apiBase}/status/${encodeURIComponent(item.incident_id)}`);
    if (res.status === 404) {
      item.status = "queued";
      return;
    }
    if (!res.ok) return;

    const data = await res.json();
    Object.assign(item, data);
    if (data.status !== "resolved") {
      delete item.resolution_note;
      delete item.resolved_at;
    }

    if (previous !== item.status && item.status === "resolved") {
      notify("Update: a checkout failure you reported has been resolved.");
    } else if (previous !== item.status && item.status === "acknowledged") {
      notify("Update: an engineer is investigating a checkout failure you reported.");
    }
  } catch (err) {
    /* offline or transient error: keep the last known status */
  }
}

async function refreshUpdates() {
  if (document.visibilityState === "hidden") return;
  const pending = tracked.filter((t) => t.status !== "resolved");
  if (pending.length === 0) return;
  await Promise.all(pending.map(fetchUpdate));
  saveTracked();
  renderUpdates();
}

function renderUpdates() {
  updatesPanel.classList.toggle("hidden", tracked.length === 0);
  updatesList.replaceChildren(...tracked.map(updateCard));
}

function updateCard(item) {
  const status = UPDATE_TEXT[item.status] ? item.status : "queued";
  const text = UPDATE_TEXT[status];
  const card = el("article", `update-card ${status}`);

  const head = el("div", "update-head");
  head.append(el("strong", "", "Checkout failure"), el("span", `update-badge ${status}`, text.label));
  card.append(head, el("p", "update-note", text.note));

  if (status === "resolved" && item.resolution_note) {
    const fix = el("div", "resolution");
    fix.append(el("strong", "", "What we did"), el("p", "", item.resolution_note));
    card.append(fix);
  }

  let meta = `Reported ${new Date(item.created_at).toLocaleString()}`;
  if (item.resolved_at) meta += ` · Resolved ${new Date(item.resolved_at).toLocaleString()}`;
  card.append(el("small", "update-meta", meta), el("code", "incident-id", item.incident_id));
  return card;
}

async function checkout() {
  if (cart.length === 0) {
    showStatus("error", "Cart is empty", "Add a product before checking out.");
    return;
  }

  const total = cartTotal();

  if (failToggle.checked) {
    const errorMessage =
      "HTTP 500 Internal Server Error during checkout. Simulated failure triggered from demo site. Cart total: ₹" +
      total;

    checkoutBtn.disabled = true;
    showStatus("pending", "Checkout returned HTTP 500", "Sending the incident to the assistant…");

    try {
      const result = await sendIncidentAlert(errorMessage);
      showStatus(
        "error",
        "Checkout failed with HTTP 500",
        "Incident queued. Follow its progress under Incident updates below.",
        result.incident_id
      );
      trackIncident(result.incident_id);
    } catch (err) {
      showStatus("error", "Checkout failed with HTTP 500", `The alert could not be delivered: ${err.message}`);
    } finally {
      checkoutBtn.disabled = false;
    }
    return;
  }

  cart = [];
  renderCart();
  showStatus("success", "Order placed", `Thanks for shopping with us. Your order total was ${money(total)}.`);
}

checkoutBtn.addEventListener("click", checkout);
dashboardLink.href = CONFIG.dashboardUrl;

renderProducts();
renderCart();
renderUpdates();
refreshUpdates();
setInterval(refreshUpdates, POLL_MS);
