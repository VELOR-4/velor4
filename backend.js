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
    open(head("Orders") + (data.length ? data.map(o => `<div class="box"><b>${o.order_no}</b> · ${inr(o.total)} · ${o.method == "cod" ? "Cash on delivery" : "Online"}<br><span class="muted">${new Date(o.created_at).toLocaleString("en-IN")}</span><br>${safe(o.name)} · ${safe(o.phone)}<br><span class="muted">${safe(o.address)} – ${safe(o.pincode)}</span><br><br>${(o.items || []).map(i => { const p = find(i.id); return (p ? safe(p.n) : "Item " + i.id) + (i.sz ? " (" + i.sz + ")" : "") + " × " + i.q; }).join("<br>")}<br><br><select id="st-${o.id}">${ST.map(x => `<option value="${x}"${x == o.status ? " selected" : ""}>${x.replace(/_/g, " ")}</option>`).join("")}</select><button class="big" style="margin-top:8px" data-ost="${o.id}">Update status</button></div>`).join("") : `<div class="box">No orders yet.</div>`), "so");
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
