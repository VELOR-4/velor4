// Connects the VELOR4 store to Supabase (login, products, orders) and Razorpay (payments).
// If config.js is empty, the store keeps working in demo mode.
(async () => {
  const C = window.VELOR4 || {};
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) { console.info("VELOR4: demo mode"); return; }
  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  let isAdmin = false;
  const SL = ["placed", "packed", "shipped", "out_for_delivery", "delivered"];
  stage = o => Math.max(0, SL.indexOf(o.status));

  async function loadProducts() {
    const { data, error } = await sb.from("products").select("*").eq("active", true).order("created_at", { ascending: false });
    if (error) { toast("Could not load products"); return; }
    P0.length = 0; hidden = [];
    custom = data.map(r => ({
      id: r.id, c: r.category, b: r.brand, n: r.name, p: r.price, m: r.mrp,
      e: r.image_url ? `<img src="${safe(r.image_url)}" alt="">` : "📦",
      bg: "#ECE6FB", r: 0, rv: "0", s: r.sizes && r.sizes.length ? r.sizes : undefined
    }));
    Object.keys(cart).forEach(k => { if (!find(k.split("|")[0])) delete cart[k]; });
    save(); buildP(); render();
  }
  async function loadOrders() {
    if (!user) { orders = []; return; }
    const { data } = await sb.from("orders").select("*").order("created_at", { ascending: false });
    orders = (data || []).filter(o => o.paid || o.method == "cod").map(o => ({
      no: o.order_no, t: Date.parse(o.created_at), ph: user.ph, nm: o.name,
      ad: o.address + " – " + o.pincode, py: o.method == "cod" ? "Cash on delivery" : "Online payment",
      total: o.total, items: o.items, status: o.status
    }));
  }
  async function restore() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { user = null; isAdmin = false; sv("velor4-user", null); return; }
    const { data: pr } = await sb.from("profiles").select("name,phone,is_admin").eq("id", session.user.id).single();
    user = { nm: (pr && pr.name) || (tmpU && tmpU.nm) || "Customer", ph: ((pr && pr.phone) || session.user.phone || "").slice(-10), em: session.user.email || "" };
    isAdmin = !!(pr && pr.is_admin); sv("velor4-user", user);
  }
  window.sbOut = async () => { await sb.auth.signOut(); isAdmin = false; orders = []; };

  const sendOtpPhone = async function () {
    const nm = $("#ln").value.trim(), ph = $("#lp").value.trim();
    if (!nm || !/^[6-9]\d{9}$/.test(ph)) { $("#err").textContent = "Enter your name and a valid 10-digit mobile number."; return; }
    const { error } = await sb.auth.signInWithOtp({ phone: "+91" + ph, options: { data: { name: nm } } });
    if (error) { $("#err").textContent = "Could not send OTP: " + (error.message || error.code || "unknown error"); return; }
    tmpU = { nm, ph };
    open(head("Verify OTP") + `<div class="box"><p>Enter the OTP sent to +91 ${ph}.</p><input class="f" id="ot" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="OTP"><div class="err" id="err" role="alert"></div></div><button class="big" data-ver>Verify and continue</button>`, "l2");
  };
  const verifyPhone = async function () {
    const { error } = await sb.auth.verifyOtp({ phone: "+91" + tmpU.ph, token: $("#ot").value.trim(), type: "sms" });
    if (error) { $("#err").textContent = "OTP problem: " + (error.message || "unknown error"); return; }
    await restore(); await loadOrders(); toast("Logged in");
    after == "co" ? viewCheckout() : viewAccount();
  };

  // ---------- Email login (SMS login is kept for later) ----------
  let loginMode = "email";
  const viewLoginPhone = viewLogin;
  viewLogin = function (next) {
    loginMode = "email"; after = next || "";
    open(head("Login") + `<div class="box"><b>Login or sign up</b><p class="muted">${next ? "Log in to place your order." : "Log in to see your orders and track them."}</p><label class="l" for="ln">Name</label><input class="f" id="ln" autocomplete="name"><label class="l" for="le">Email</label><input class="f" id="le" type="email" autocomplete="email"><div class="err" id="err" role="alert"></div></div><button class="big" data-otp>Get login code</button><p style="text-align:center"><button class="lnk" data-phone>Seller? Login with mobile</button></p>`, "l");
  };
  document.addEventListener("click", e => {
    if (e.target.closest("[data-phone]")) { loginMode = "phone"; viewLoginPhone(after); }
  });
  const sendOtpEmail = async function () {
    const nm = $("#ln").value.trim(), em = $("#le").value.trim().toLowerCase();
    if (!nm || !/^\S+@\S+\.\S+$/.test(em)) { $("#err").textContent = "Enter your name and a valid email address."; return; }
    const { error } = await sb.auth.signInWithOtp({ email: em, options: { data: { name: nm } } });
    if (error) { $("#err").textContent = "Could not send code: " + (error.message || "unknown error"); return; }
    tmpU = { nm, em, ph: "" };
    open(head("Enter code") + `<div class="box"><p>We sent a login code to <b>${safe(em)}</b>. Check your inbox and spam folder.</p><input class="f" id="ot" inputmode="numeric" maxlength="8" autocomplete="one-time-code" aria-label="Login code"><div class="err" id="err" role="alert"></div></div><button class="big" data-ver>Verify and continue</button>`, "l2");
  };
  const verifyEmail = async function () {
    const { error } = await sb.auth.verifyOtp({ email: tmpU.em, token: $("#ot").value.trim(), type: "email" });
    if (error) { $("#err").textContent = "Wrong or expired code: " + (error.message || "try again"); return; }
    await restore(); await loadOrders(); toast("Logged in");
    after == "co" ? viewCheckout() : viewAccount();
  };
  sendOtp = () => loginMode == "phone" ? sendOtpPhone() : sendOtpEmail();
  verify = () => loginMode == "phone" ? verifyPhone() : verifyEmail();

  // show email in account sheet; remove the old "demo speed" note from tracking
  const _va = viewAccount;
  viewAccount = function () {
    _va();
    if (user && !user.ph && user.em) {
      const m = [...document.querySelectorAll("#sheet .muted")].find(x => x.textContent.trim().startsWith("+91"));
      if (m) m.textContent = user.em;
    }
  };
  const _vt = viewTrack;
  viewTrack = function (no) {
    _vt(no);
    document.querySelectorAll("#sheet .muted").forEach(x => { if (x.textContent.includes("Demo speed")) x.remove(); });
  };


  // ---------- Seller: orders list with status update ----------
  const ST = ["placed", "packed", "shipped", "out_for_delivery", "delivered"];
  async function viewSellerOrders() {
    if (!isAdmin) return;
    const { data, error } = await sb.from("orders").select("*").neq("status", "pending_payment").order("created_at", { ascending: false }).limit(30);
    if (error) { toast("Could not load orders"); return; }
    lastOrders = data;
    open(head("Orders") + (data.length ? data.map(o => `<div class="box"><b>${o.order_no}</b> · ${inr(o.total)} · ${o.method == "cod" ? "Cash on delivery" : "Online"}<br><span class="muted">${new Date(o.created_at).toLocaleString("en-IN")}</span><br>${safe(o.name)} · ${safe(o.phone)}<br><span class="muted">${safe(o.address)} – ${safe(o.pincode)}</span><br><br>${(o.items || []).map(i => { const p = find(i.id); return (p ? safe(p.n) : "Item " + i.id) + (i.sz ? " (" + i.sz + ")" : "") + " × " + i.q; }).join("<br>")}<br><br><select id="st-${o.id}">${ST.map(x => `<option value="${x}"${x == o.status ? " selected" : ""}>${x.replace(/_/g, " ")}</option>`).join("")}</select><button class="big" style="margin-top:8px" data-ost="${o.id}">Update status</button><button class="sz" style="width:100%;margin-top:8px;border-radius:12px;padding:12px" data-inv="${o.id}">Invoice</button></div>`).join("") : `<div class="box">No orders yet.</div>`), "so");
  }
  document.addEventListener("click", async e => {
    if (e.target.closest("[data-sord]")) { viewSellerOrders(); return; }
    const b = e.target.closest("[data-ost]");
    if (b && isAdmin) {
      const v = document.getElementById("st-" + b.dataset.ost).value;
      const { error } = await sb.from("orders").update({ status: v }).eq("id", b.dataset.ost);
      toast(error ? "Could not update" : "Status updated");
    }
  });

  // ---------- Invoice (seller): print or save as PDF ----------
  let lastOrders = [];
  const BIZ_GSTIN = ""; // put your GSTIN here if you are GST registered, e.g. "27ABCDE1234F1Z5"
  const pst = document.createElement("style");
  pst.textContent = "@media print{body>*:not(#sheet){display:none!important}body::before{display:none!important}#sheet{position:static!important;display:block!important;max-height:none!important;width:auto!important;overflow:visible!important;background:#fff!important;padding:0!important}#sheet *{color:#000!important;background:transparent!important;box-shadow:none!important}.noprint{display:none!important}}";
  document.head.appendChild(pst);
  function viewInvoice(id) {
    const o = lastOrders.find(x => String(x.id) === String(id));
    if (!o) return;
    const items = o.items || [];
    const rows = items.map(i => { const p = find(i.id); return { n: p ? safe(p.n) + (i.sz ? " (" + i.sz + ")" : "") : "Item", q: i.q, p: p ? p.p : null }; });
    const known = rows.every(r => r.p !== null);
    const sum = known ? rows.reduce((a, r) => a + r.p * r.q, 0) : 0;
    const diff = known ? o.total - sum : 0;
    const td = "padding:6px 4px;border-bottom:1px solid #ccc;";
    const table = known ? `<table style="width:100%;border-collapse:collapse;font-size:.9rem"><tr><th style="${td}text-align:left">Item</th><th style="${td}text-align:right">Qty</th><th style="${td}text-align:right">Price</th><th style="${td}text-align:right">Amount</th></tr>${rows.map(r => `<tr><td style="${td}">${r.n}</td><td style="${td}text-align:right">${r.q}</td><td style="${td}text-align:right">${inr(r.p)}</td><td style="${td}text-align:right">${inr(r.p * r.q)}</td></tr>`).join("")}</table><p style="text-align:right;margin:8px 0 0">Items total: ${inr(sum)}</p>${diff > 0 ? `<p style="text-align:right;margin:2px 0">Delivery and other charges: ${inr(diff)}</p>` : diff < 0 ? `<p style="text-align:right;margin:2px 0">Discount: − ${inr(-diff)}</p>` : ""}` : `<p>${rows.map(r => r.n + " × " + r.q).join("<br>")}</p>`;
    open(`<div class="top noprint"><h2>Invoice</h2><button class="x" data-close aria-label="Close">✕</button></div><div class="box" style="line-height:1.5;font-size:.92rem"><h2 style="margin:0">VELORA</h2><div>VELOR4, Rudra Apartment, Dongri Pada, Near ARC Transport, Sativali Naka, Vasai East, District Palghar, Maharashtra 401208, India<br>riyaenterprises77150@gmail.com${BIZ_GSTIN ? "<br>GSTIN: " + safe(BIZ_GSTIN) : ""}</div><hr style="margin:10px 0"><div><b>Invoice no:</b> ${o.order_no}<br><b>Date:</b> ${new Date(o.created_at).toLocaleDateString("en-IN")}</div><div style="margin:10px 0"><b>Bill to:</b><br>${safe(o.name)}<br>${safe(o.phone)}<br>${safe(o.address)} – ${safe(o.pincode)}</div>${table}<p style="text-align:right;font-weight:800;font-size:1.05rem;margin:8px 0">Total: ${inr(o.total)}</p><p>Payment: ${o.method == "cod" ? "Cash on delivery (pay when the order arrives)" : "Online payment"}</p><p style="font-size:.8rem">This is a computer-generated invoice.</p></div><button class="big noprint" data-print>Save or print as PDF</button>`, "inv");
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-inv]");
    if (b && isAdmin) { viewInvoice(b.dataset.inv); return; }
    if (e.target.closest("[data-print]")) window.print();
  });
  const _vad = viewAdmin;
  viewAdmin = function () {
    _vad();
    const top = document.querySelector("#sheet .top");
    if (top) { const b = document.createElement("button"); b.className = "big alt"; b.textContent = "View orders"; b.setAttribute("data-sord", ""); b.style.marginBottom = "10px"; top.after(b); }
  };

  viewPin = function () {
    if (isAdmin) { viewAdmin(); return; }
    open(head("Seller login") + `<div class="box">${user ? "This account is not a seller account." : "Log in with your seller mobile number first, then tap Seller login again."}</div><button class="big" data-close>OK</button>`, "s");
  };
  delProduct = async function (id) {
    if (!isAdmin) return;
    const { error } = await sb.from("products").delete().eq("id", id);
    if (error) { toast("Could not remove"); return; }
    await loadProducts(); viewAdmin();
  };
  addProduct = async function () {
    if (!isAdmin) return;
    const b = $("#ab").value.trim(), n = $("#an").value.trim(), p = +$("#ap").value, m = +$("#am").value, c = $("#ac").value, s = $("#as").value;
    if (!b || !n || !(p > 0) || !(m > p)) { $("#err").textContent = "Fill brand, name and price. MRP must be higher than the selling price."; return; }
    let url = null;
    if (photo) {
      const blob = await (await fetch(photo)).blob(), path = Date.now() + ".jpg";
      const up = await sb.storage.from("product-images").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) { $("#err").textContent = "Photo upload failed."; return; }
      url = sb.storage.from("product-images").getPublicUrl(path).data.publicUrl;
    }
    const { error } = await sb.from("products").insert({ brand: b, name: n, category: c, price: p, mrp: m, image_url: url, sizes: s == "A" ? AP : s == "S" ? SH : null });
    if (error) { $("#err").textContent = "Could not add product."; return; }
    await loadProducts(); toast("Product added"); viewAdmin();
  };

  async function done(res, py, nm, ad, pn) {
    const d = new Date(Date.now() + 4 * 864e5).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    cart = {}; coupon = ""; save(); render(); await loadOrders();
    open(head("Order placed") + `<div class="box" style="text-align:center"><div style="font-size:3rem">🎉</div><b>Order ${res.order_no} confirmed</b><p>Delivery by <b>${d}</b></p><p class="muted">${inr(res.total)} via ${py}<br>Shipping to ${safe(nm)}, ${safe(ad)} – ${pn}</p></div><button class="big" data-track="${res.order_no}">Track order</button><br><br><button class="sz" data-close style="width:100%;border-radius:12px;padding:12px">Continue shopping</button>`, "d");
  }
  pay = async function () {
    const nm = $("#nm").value.trim(), ph = $("#ph").value.trim(), ad = $("#ad").value.trim(), pn = $("#pn").value.trim();
    if (!nm || !/^[6-9]\d{9}$/.test(ph) || ad.length < 6 || !/^\d{6}$/.test(pn)) { $("#err").textContent = "Enter your name, a 10-digit mobile number, address and 6-digit PIN code."; return; }
    const btn = document.querySelector("[data-pay]"), py = document.querySelector('input[name="py"]:checked').value;
    const fail = m => { $("#err").textContent = m; btn.disabled = false; };
    btn.disabled = true;
    const { data, error } = await sb.functions.invoke("dynamic-worker", {
      body: { items: lines().map(({ p, sz, q }) => ({ id: p.id, sz, q })), coupon, method: py == "Cash on delivery" ? "cod" : "online", name: nm, phone: ph, address: ad, pincode: pn }
    });
    if (error || !data || data.error) {
      let msg = (data && data.error) || "Could not place the order";
      if (error) {
        try { const r = error.context; const j = await r.json(); msg = (j.error || j.message || msg) + " [" + r.status + "]"; }
        catch (e) { msg = (error.message || msg) + (error.context && error.context.status ? " [" + error.context.status + "]" : ""); }
      }
      fail(msg); return;
    }
    if (!data.razorpay_order_id) { done(data, py, nm, ad, pn); return; }
    if (!window.Razorpay) { fail("Payment window could not load. Check your internet."); return; }
    new Razorpay({
      key: data.key, amount: data.amount, currency: "INR", order_id: data.razorpay_order_id, name: "VELOR4",
      prefill: { name: nm, contact: ph },
      handler: async r => {
        const v = await sb.functions.invoke("verify-payment", { body: r });
        if (v.error) { fail("Payment received but not confirmed. Contact support with order " + data.order_no); return; }
        done(data, py, nm, ad, pn);
      },
      modal: { ondismiss: () => fail("Payment was cancelled. You can try again.") }
    }).open();
  };

  await restore();
  await Promise.all([loadProducts(), loadOrders()]);
})();

// ---------- Policy pages (footer links) ----------
(() => {
  const EMAIL = "riyaenterprises77150@gmail.com";
  const ADDR = "VELOR4, Rudra Apartment, Dongri Pada, Near ARC Transport, Sativali Naka, Vasai East, District Palghar, Maharashtra 401208, India";
  const mail = `<a href="mailto:${EMAIL}" style="color:var(--brand)">${EMAIL}</a>`;
  const H = t => `<h3 style="margin:16px 0 4px;font-size:1rem">${t}</h3>`;
  const wrap = h => `<div style="line-height:1.55;font-size:.92rem">${h}</div>`;
  const POL = {
    returns: { t: "Returns", h: wrap(
      H("7-day returns") + `<p>You can request a return within 7 days of receiving your order.</p>` +
      H("What can be returned") + `<p>Items must be unused, in original packaging, with tags and accessories. Used, washed or customer-damaged items may not be accepted. Opened beauty and personal-care items cannot be returned for hygiene reasons.</p>` +
      H("How to return") + `<p>Email ${mail} with your order number, a photo of the item and the reason. We will reply with the next steps.</p>` +
      H("Return shipping") + `<p>The customer pays the return shipping cost. If your item arrived damaged, defective or wrong, email us within 7 days and we will tell you how we will fix it.</p>` +
      H("Refunds") + `<p>After we receive and check the returned item, we refund the amount to your original payment method. For cash on delivery orders we will ask for your UPI or bank details. We will email you when the refund is started.</p>` +
      H("Cancellation") + `<p>To cancel an order, email us before it is shipped, with your order number.</p>`) },
    shipping: { t: "Shipping", h: wrap(
      H("Delivery time") + `<p>Orders are usually delivered in 3 to 5 days, depending on your location.</p>` +
      H("Delivery charges") + `<p>Delivery is free on orders of ₹499 and above. Below ₹499, a delivery charge of ₹40 applies.</p>` +
      H("Payment") + `<p>Cash on delivery is available: you pay when the order arrives. Other payment options, when available, are shown at checkout.</p>` +
      H("Tracking") + `<p>After you log in, open your account and tap <b>My orders</b>, then <b>Track order</b>. We update the status as your order moves.</p>` +
      H("Correct details") + `<p>Please enter your full address, correct PIN code and a working mobile number. Delays caused by wrong details are not our responsibility.</p>`) },
    privacy: { t: "Privacy", h: wrap(
      H("What we collect") + `<p>Your name, email address, mobile number, delivery address and order details, when you log in or place an order.</p>` +
      H("How we use it") + `<p>To log you in, process and deliver your orders, show your order status, and reply to your questions. We do not sell your personal information.</p>` +
      H("Who handles it") + `<p>We use trusted service providers to run the store, such as our database and login service, our email service and our delivery and payment partners. They get only what is needed to do their job.</p>` +
      H("On your device") + `<p>The site saves your cart and login on your device so they are there when you come back.</p>` +
      H("Your choices") + `<p>To see, correct or delete your information, email ${mail}.</p>`) },
    terms: { t: "Terms", h: wrap(
      `<p>By using this store you agree to these terms.</p>` +
      H("Orders") + `<p>An order is confirmed when you see the order confirmation. We may cancel an order if an item is unavailable or there is an error in price or details, and we will tell you by email.</p>` +
      H("Prices") + `<p>All prices are in Indian rupees (₹). Prices and offers can change without notice. Product photos are for reference and colours may look slightly different.</p>` +
      H("Your account") + `<p>Please give correct details and keep your login code private.</p>` +
      H("Returns and shipping") + `<p>See our Returns and Shipping pages for those rules.</p>` +
      H("Law") + `<p>These terms follow the laws of India.</p>`) },
    contact: { t: "Contact", h: wrap(
      `<p><b>VELORA</b> (VELOR4)</p><p>${ADDR}</p><p>Email: ${mail}</p><p>Please include your order number so we can help you faster. We reply by email.</p>`) }
  };
  const links = Object.keys(POL).map(k => `<button class="lnk" data-pol="${k}">${POL[k].t}</button>`).join("");
  const sell = document.querySelector("[data-sell]");
  if (sell && sell.parentElement) {
    const f = document.createElement("div");
    f.style.cssText = "text-align:center;padding:0 14px 30px;font-size:.85rem;color:var(--muted)";
    f.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:center;margin-bottom:8px">${links}</div><div>© 2026 VELORA · VELOR4</div>`;
    sell.parentElement.after(f);
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-pol]");
    if (b) open(head(POL[b.dataset.pol].t) + `<div class="box">${POL[b.dataset.pol].h}</div>`, "pol");
  });
})();

// ---------- Cash on delivery only (until online payment is set up) ----------
(() => {
  const _vc = viewCheckout;
  viewCheckout = function () {
    _vc();
    document.querySelectorAll("#sheet .pay").forEach(l => {
      const r = l.querySelector("input");
      if (r && r.value !== "Cash on delivery") l.remove(); else if (r) r.checked = true;
    });
  };
})();

// ---------- Install as an app (PWA) ----------
(() => {
  const hd = document.head;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k])); hd.appendChild(el); };
  add("link", { rel: "manifest", href: "manifest.json" });
  add("meta", { name: "theme-color", content: "#5B2BD9" });
  add("link", { rel: "apple-touch-icon", href: "icon-192.png" });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  let dp = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); dp = e; });
  const first = document.querySelector("[data-pol]");
  if (first && first.parentElement) {
    const b = document.createElement("button");
    b.className = "lnk"; b.setAttribute("data-install", ""); b.textContent = "Install app";
    first.parentElement.appendChild(b);
  }
  document.addEventListener("click", async e => {
    if (!e.target.closest("[data-install]")) return;
    if (dp) { dp.prompt(); try { await dp.userChoice; } catch (_) {} dp = null; return; }
    open(head("Install VELOR4 app") + `<div class="box" style="line-height:1.6"><p><b>Android (Chrome):</b> tap the ⋮ menu at the top, then <b>Install app</b> or <b>Add to Home screen</b>.</p><p><b>iPhone (Safari):</b> tap the Share button, then <b>Add to Home Screen</b>.</p><p class="muted">The VELOR4 icon will appear on your home screen and open like an app. If it is already installed, open it from your home screen.</p></div><button class="big" data-close>OK</button>`, "inst");
  });
})();

// ---------- VELOR4 look: original marketplace design ----------
(() => {
  // Promo slides. Add your own ads here: { t:"Title", s:"Subtitle", bg:"css background", img:"https://...", link:"https://...", tag:"Sponsored" }
  const BANNERS = [
    { t: "Free delivery over ₹499", s: "Cash on delivery on every order", bg: "linear-gradient(120deg,#4A1FC4,#7B4DF0)" },
    { t: "7-day easy returns", s: "Shop without worry", bg: "linear-gradient(120deg,#0E7C66,#27B98F)" },
    { t: "Advertise your brand here", s: "Email us to book this space", bg: "linear-gradient(120deg,#C2410C,#F59E0B)", tag: "Sponsored", link: "mailto:riyaenterprises77150@gmail.com" }
  ];
  const css = `
:root{--bg:#F6F5FB;--surface:#fff;--ink:#1B1633;--muted:#6E6A85;--line:#E8E5F3;--brand:#5B2BD9;--brand2:#FFB400;--on:#fff;--soft:#EFEAFF;--ok:#12805C;--bad:#D63A6A}
body{background:var(--bg);padding-bottom:calc(86px + env(safe-area-inset-bottom,0px))}
body::before{background:#4A1FC4}
header{background:linear-gradient(135deg,#4A1FC4,#7B4DF0);border:0;padding:12px 14px 16px;border-radius:0 0 22px 22px;box-shadow:0 6px 20px rgba(74,31,196,.25)}
.logo{color:#fff;letter-spacing:-1px}
.logo b{background:#FFB400;color:#2A1B00;border-radius:8px}
.ib{background:#fff;border:0;color:#5B2BD9}
.ib i{background:#D63A6A;color:#fff}
.search{background:#fff;border:0;border-radius:14px;padding:13px 16px;color:#1B1633;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.cats{padding:16px 14px 4px;gap:14px}
.cat{color:var(--ink);width:68px}
.cat span{width:60px;height:60px;background:#fff;border:2px solid transparent;box-shadow:0 2px 8px rgba(40,20,120,.10)}
.cat[aria-pressed="true"]{color:var(--brand)}
.cat[aria-pressed="true"] span{border-color:var(--brand);background:var(--soft)}
.banner{display:none}
.promo{position:relative;display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:8px 14px 4px;scrollbar-width:none}
.promo::-webkit-scrollbar{display:none}
.slide{flex:0 0 88%;scroll-snap-align:center;border-radius:20px;padding:20px 18px;color:#fff;text-decoration:none;min-height:124px;display:flex;flex-direction:column;justify-content:center;position:relative;background-size:cover;background-position:center}
.slide b{font:800 1.3rem/1.15 Sora,"Plus Jakarta Sans",sans-serif}
.slide span{opacity:.92;font-size:.9rem;margin-top:4px}
.slide em{position:absolute;top:10px;right:12px;font-style:normal;font-size:.65rem;background:rgba(0,0,0,.32);padding:2px 8px;border-radius:999px}
#deals h2{font-size:1.1rem;margin:14px 14px 8px}
.dr{display:flex;gap:10px;overflow-x:auto;padding:0 14px 6px;scrollbar-width:none}
.dr::-webkit-scrollbar{display:none}
.dc{flex:0 0 124px;border:0;background:#fff;border-radius:16px;padding:8px;text-align:left;box-shadow:0 2px 10px rgba(40,20,120,.08);display:flex;flex-direction:column;gap:3px}
.dpic{aspect-ratio:1;border-radius:12px;display:grid;place-items:center;font-size:2.6rem;overflow:hidden}
.dpic img{width:100%;height:100%;object-fit:cover}
.dc b{font-size:1rem}.dc span{color:var(--ok);font-weight:700;font-size:.8rem}
.tools{padding-top:16px}.tools h2{font-size:1.15rem}
.card{border:0;border-radius:18px;box-shadow:0 2px 10px rgba(40,20,120,.08)}
.pic{position:relative;border-radius:0}
.bdg{position:absolute;left:8px;top:8px;background:#D63A6A;color:#fff;font-weight:800;font-size:.7rem;line-height:1;padding:5px 9px;border-radius:999px}
.body{padding:10px 12px 14px}
.br{font-size:.74rem;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.nm{color:var(--ink);font-weight:600}
.pr b{font-size:1.1rem}
.sheet{background:var(--bg);border-radius:24px 24px 0 0}
.big{background:linear-gradient(135deg,#5B2BD9,#7B4DF0);color:#fff;border-radius:14px;box-shadow:0 6px 16px rgba(91,43,217,.28)}
.big.alt{background:#FFB400;color:#2A1B00;box-shadow:none}
.box{border-radius:16px}
.tile{border:0;background:#fff;border-radius:16px;padding:14px 6px;display:flex;flex-direction:column;align-items:center;gap:6px;font-weight:600;box-shadow:0 2px 8px rgba(40,20,120,.08)}
.tile span{font-size:1.8rem}
.lnk{color:var(--muted)}
#bn{position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:8;display:none;background:#fff;border-radius:22px;box-shadow:0 8px 28px rgba(40,20,120,.22);padding:8px 4px;max-width:520px;margin:0 auto}
#bn button{position:relative;border:0;background:none;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:.7rem;font-weight:600;color:var(--muted);flex:1;padding:4px 0}
#bn em{font-style:normal;font-size:1.35rem;line-height:1}
#bn i{position:absolute;top:-2px;left:calc(50% + 6px);background:#D63A6A;color:#fff;font-style:normal;font-size:.65rem;min-width:17px;height:17px;border-radius:9px;display:grid;place-items:center;padding:0 4px}
#bn i[hidden]{display:none}
@media(max-width:699px){#bn{display:flex}.ib{display:none}}
.toast{bottom:calc(98px + env(safe-area-inset-bottom,0px))}`;
  document.documentElement.setAttribute("data-theme", "light");
  const st = document.createElement("style"); st.id = "look-css"; st.textContent = css; document.head.appendChild(st);
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", "#4A1FC4");

  // promo slides (ads)
  const promo = document.createElement("div"); promo.className = "promo";
  promo.innerHTML = BANNERS.map(b => {
    const st2 = `background:${b.img ? `linear-gradient(0deg,rgba(0,0,0,.35),rgba(0,0,0,.1)),url('${b.img}')` : b.bg};`;
    const inner = `${b.tag ? `<em>${b.tag}</em>` : ""}<b>${b.t}</b><span>${b.s || ""}</span>`;
    return b.link ? `<a class="slide" href="${b.link}" style="${st2}">${inner}</a>` : `<div class="slide" style="${st2}">${inner}</div>`;
  }).join("");
  const ban = document.querySelector(".banner"); if (ban) ban.after(promo);
  let si = 0;
  setInterval(() => {
    const sl = promo.querySelectorAll(".slide"); if (sl.length < 2) return;
    si = (si + 1) % sl.length; promo.scrollTo({ left: sl[si].offsetLeft - 14, behavior: "smooth" });
  }, 4500);

  // top deals row + discount badges
  const deals = document.createElement("div"); deals.id = "deals";
  const tools = document.querySelector(".tools"); if (tools) tools.before(deals);
  function decorate() {
    const list = [...P].map(p => ({ p, off: Math.round((1 - p.p / p.m) * 100) })).filter(x => x.off >= 20).sort((a, b) => b.off - a.off).slice(0, 8);
    deals.innerHTML = (cat == "All" && !term && list.length >= 2) ? `<h2>Top deals</h2><div class="dr">${list.map(x => `<button class="dc" data-v="${x.p.id}" aria-label="View ${safe(x.p.n)}"><div class="dpic" style="background:${x.p.bg}">${x.p.e}</div><b>${inr(x.p.p)}</b><span>${x.off}% off</span></button>`).join("")}</div>` : "";
    document.querySelectorAll("#grid .card").forEach(c => {
      const off = c.querySelector(".off"), pic = c.querySelector(".pic");
      if (off && pic && !pic.querySelector(".bdg")) { const b = document.createElement("span"); b.className = "bdg"; b.textContent = off.textContent.replace(" off", " OFF"); pic.appendChild(b); }
    });
  }
  const _rd = render;
  render = function () { _rd(); decorate(); };
  decorate();

  // bottom navigation (phones)
  const nav = document.createElement("nav"); nav.id = "bn"; nav.setAttribute("aria-label", "Main");
  nav.innerHTML = `<button data-bn="home"><em>🏠</em>Home</button><button data-bn="cats"><em>🗂️</em>Categories</button><button data-bn="wl"><em>♥</em>Wishlist<i hidden>0</i></button><button data-bn="ct"><em>🛒</em>Cart<i hidden>0</i></button><button data-bn="ac"><em>👤</em>Account</button>`;
  document.body.appendChild(nav);
  const link = (srcId, key) => {
    const src = document.getElementById(srcId), dst = nav.querySelector(`[data-bn="${key}"] i`);
    if (!src || !dst) return;
    const sync = () => { dst.hidden = src.hidden; dst.textContent = src.textContent; };
    new MutationObserver(sync).observe(src, { childList: true, characterData: true, subtree: true, attributes: true }); sync();
  };
  link("wc", "wl"); link("cc", "ct");
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-bn]"); if (!b) return;
    const k = b.dataset.bn;
    if (k == "home") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (k == "cats") open(head("Categories") + `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${CATS.map(([c, e]) => `<button class="tile" data-c="${c}" data-close><span>${e}</span>${c}</button>`).join("")}</div>`, "cats");
    else { const t = document.getElementById(k); if (t) t.click(); }
  });
})();
