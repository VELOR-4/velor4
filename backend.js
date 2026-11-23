/* © 2026 VELOR4. All rights reserved. Copying or reusing this code, design or content without written permission is not allowed. */
// ---------- Google Analytics (switches on when GA_ID is set in settings.js) ----------
(() => {
  const X = window.VELOR4_EXTRA || {}, id = String(X.GA_ID || "").trim();
  window.track = () => {};
  if (!/^G-[A-Z0-9]{6,14}$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag("js", new Date()); gtag("config", id);
  const sc = document.createElement("script"); sc.async = true; sc.src = "https://www.googletagmanager.com/gtag/js?id=" + id; document.head.appendChild(sc);
  window.track = (n, p) => { try { gtag("event", n, p || {}); } catch (_) {} };
})();
// Connects the VELOR4 store to Supabase (login, products, orders) and Razorpay (payments).
// If config.js is empty, the store keeps working in demo mode.
(async () => {
  const C = window.VELOR4 || {};
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) { loadState = (C.SUPABASE_URL && !window.supabase) ? "error" : "ready"; render(); window.__retryLoad = null; console.info("VELOR4: no database connection"); return; }
  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  let isAdmin = false;
  const SL = ["placed", "packed", "shipped", "out_for_delivery", "delivered"];
  stage = o => Math.max(0, SL.indexOf(o.status));

  let inflight = null;
  let RTM = {}; // product id -> { avg_rating, review_count }
  const mapP = r => {
    const imgs = (r.product_images || []).slice().sort((a, b) => ((b.is_main ? 1 : 0) - (a.is_main ? 1 : 0)) || (a.position - b.position)).map(x => x.url);
    const vs = (r.product_variants || []).filter(v => v.active !== false);
    const stock = vs.reduce((a, v) => a + (v.stock || 0), 0);
    const sizes = [...new Set(vs.filter(v => v.stock > 0 && v.size).map(v => v.size))];
    const main = imgs[0] || r.image_url;
    return {
      id: r.id, c: r.category, b: r.brand, n: r.name, p: r.price, m: r.mrp,
      e: main ? `<img src="${safe(main)}" alt="">` : "📦", bg: "#E6EEFD", r: 0, rv: "0",
      s: vs.length ? (sizes.length ? sizes : undefined) : (r.sizes && r.sizes.length ? r.sizes : undefined),
      imgs, desc: r.description || "", mat: r.material || "", deliv: r.delivery_estimate || "", ret: r.return_days,
      spec: Array.isArray(r.specs) ? r.specs : [], feat: !!r.featured, sku: r.sku || "",
      oos: r.status === "out_of_stock" || (vs.length > 0 && stock === 0)
    };
  };
  async function fetchProducts() {
    let r = await sb.from("products").select("*, product_images(url,position,is_main), product_variants(id,colour,size,stock,price,active)")
      .in("status", ["active", "out_of_stock"]).order("created_at", { ascending: false }).order("id", { ascending: false });
    if (r.error) { // database not upgraded yet (stage2a-products.sql not run): use the simple query
      r = await sb.from("products").select("*").eq("active", true).order("created_at", { ascending: false }).order("id", { ascending: false });
    }
    return r;
  }
  // One reliable source: the database. Only one request at a time, no duplicates, stable order.
  function loadProducts(silent) {
    if (inflight) return inflight;
    if (!silent) { loadState = "loading"; render(); }
    inflight = (async () => {
      let ok = false;
      try {
        const { data, error } = await fetchProducts();
        if (error) throw error;
        const seen = new Set();
        custom = data.filter(r => !seen.has(r.id) && seen.add(r.id)).map(mapP).sort((a, b) => (b.feat ? 1 : 0) - (a.feat ? 1 : 0));
        try { // average ratings (skipped silently if the reviews SQL has not been run yet)
          const rr = await sb.from("product_ratings").select("*");
          RTM = {};
          if (!rr.error && rr.data) rr.data.forEach(x => { RTM[x.product_id] = x; });
          custom.forEach(p => { const x = RTM[p.id]; if (x) { p.r = x.avg_rating; p.rv = String(x.review_count); } });
        } catch (_) {}
        hidden = [];
        const gone = Object.keys(cart).filter(k => !find(k.split("|")[0]));
        gone.forEach(k => delete cart[k]);
        if (gone.length) { save(); toast("Some items in your cart are no longer available"); }
        ok = true;
      } catch (e) {
        if (silent) toast("Could not refresh products");
      }
      if (!silent || ok) loadState = ok ? "ready" : "error";
      inflight = null;
      buildP(); render();
    })();
    return inflight;
  }
  window.__retryLoad = () => loadProducts();
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
  // ---------- Code entry in separate boxes (like Flipkart) ----------
  const OTP_LEN = Number(C.OTP_LENGTH) || 6; // set OTP_LENGTH in config.js if your login emails have a different number of digits
  const otpBox = n => `<div class="otp"><input class="otp-in" id="ot" inputmode="numeric" pattern="[0-9]*" maxlength="${n}" autocomplete="one-time-code" aria-label="Login code" data-n="${n}"><div class="otp-b" aria-hidden="true">${"<i></i>".repeat(n)}</div></div>`;
  const otpDraw = inp => {
    const v = inp.value, bs = inp.parentNode.querySelectorAll(".otp-b i");
    bs.forEach((b, i) => { b.textContent = v[i] || ""; b.className = v[i] ? "on" : i == v.length ? "cur" : ""; });
  };
  const otpFocus = () => setTimeout(() => { const o = document.getElementById("ot"); if (o) { o.focus(); otpDraw(o); } }, 200);
  document.addEventListener("input", e => {
    const o = e.target; if (!o.classList || !o.classList.contains("otp-in")) return;
    o.value = o.value.replace(/\D/g, "").slice(0, +o.dataset.n); otpDraw(o);
    if (o.value.length == +o.dataset.n) { const b = document.querySelector("[data-ver]"); if (b) b.click(); }
  });
  document.addEventListener("paste", e => {
    const o = e.target; if (!o.classList || !o.classList.contains("otp-in")) return;
    e.preventDefault();
    o.value = ((e.clipboardData || window.clipboardData).getData("text") || "").replace(/\D/g, "").slice(0, +o.dataset.n);
    o.dispatchEvent(new Event("input", { bubbles: true }));
  });
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-delgo]"); if (!b) return;
    const er = document.getElementById("delerr"), v = (document.getElementById("delc") || {}).value || "";
    if (v.trim().toUpperCase() != "DELETE") { if (er) er.textContent = "Type DELETE to confirm."; return; }
    b.disabled = true;
    const { error } = await sb.rpc("delete_my_account");
    if (error) { b.disabled = false; if (er) er.textContent = /admin/i.test(error.message || "") ? "The seller account cannot be deleted here." : "Could not delete your account. Please contact us."; return; }
    try { await sb.auth.signOut(); } catch (_) {}
    isAdmin = false; orders = []; user = null; sv("velor4-user", null); cart = {}; wish = []; save(); close(); render(); toast("Your account has been deleted");
  });

  const sendOtpPhone = async function () {
    const nm = $("#ln").value.trim(), ph = $("#lp").value.trim();
    if (!nm || !/^[6-9]\d{9}$/.test(ph)) { $("#err").textContent = "Enter your name and a valid 10-digit mobile number."; return; }
    const { error } = await sb.auth.signInWithOtp({ phone: "+91" + ph, options: { data: { name: nm } } });
    if (error) { $("#err").textContent = "Could not send OTP: " + (error.message || error.code || "unknown error"); return; }
    tmpU = { nm, ph };
    open(head("Verify OTP") + `<div class="box"><p>Enter the OTP sent to +91 ${ph}.</p>${otpBox(6)}<div class="err" id="err" role="alert"></div></div><button class="big" data-ver>Verify and continue</button>`, "l2");
    otpFocus();
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
    open(head("Login") + `<div class="lg-hero"><h2>${next ? "Log in to place your order" : "Login or sign up"}</h2><p>Get access to your orders and order tracking.</p></div><div class="box"><label class="l" for="le">Email</label><input class="f" id="le" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"><label class="l" for="ln">Your name</label><input class="f" id="ln" autocomplete="name" placeholder="Used for delivery"><div class="err" id="err" role="alert"></div><p class="muted" style="font-size:.78rem;margin:6px 0 0">By continuing, you agree to our <button class="lnk" data-pol="terms">Terms</button> and <button class="lnk" data-pol="privacy">Privacy Policy</button>.</p></div><button class="big" data-otp>Get login code</button><p style="text-align:center;margin-bottom:0"><button class="lnk" data-lpw>Login with password</button></p><p style="text-align:center"><button class="lnk" data-phone>Seller? Login with mobile</button></p>`, "l");
  };
  function viewLoginPw(next) {
    after = next || "";
    open(head("Login") + `<div class="lg-hero"><h2>Login with password</h2><p>Use the password you set in My account.</p></div><div class="box"><label class="l" for="lpe">Email</label><input class="f" id="lpe" type="email" autocomplete="email" inputmode="email"><label class="l" for="lpp">Password</label><div style="position:relative"><input class="f" id="lpp" type="password" autocomplete="current-password" style="padding-right:64px"><button type="button" class="lnk" data-eye style="position:absolute;right:10px;top:12px">Show</button></div><div class="err" id="err" role="alert"></div><button class="lnk" data-lcode>Forgot password? Login with a code</button></div><button class="big" data-lpgo>Login</button>`, "l");
  }
  document.addEventListener("click", async e => {
    const eye = e.target.closest("[data-eye]");
    if (eye) { const i = eye.previousElementSibling; i.type = i.type == "password" ? "text" : "password"; eye.textContent = i.type == "password" ? "Show" : "Hide"; return; }
    if (e.target.closest("[data-lpw]")) { viewLoginPw(after); return; }
    if (e.target.closest("[data-lcode]")) { viewLogin(after); return; }
    const go = e.target.closest("[data-lpgo]");
    if (go) {
      const em = $("#lpe").value.trim().toLowerCase(), pw = $("#lpp").value;
      if (!/^\S+@\S+\.\S+$/.test(em) || !pw) { $("#err").textContent = "Enter your email and password."; return; }
      go.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: em, password: pw });
      go.disabled = false;
      if (error) { $("#err").textContent = "Wrong email or password. No password yet? Login with a code, then set one in My account."; return; }
      tmpU = { nm: "", em, ph: "" };
      await restore(); await loadOrders(); toast("Logged in");
      after == "co" ? viewCheckout() : viewAccount();
      return;
    }
    const sv2 = e.target.closest("[data-pwsave]");
    if (sv2) {
      const p1 = $("#np1").value, p2 = $("#np2").value, er = $("#pwerr");
      if (p1.length < 8) { er.textContent = "Use at least 8 characters."; return; }
      if (p1 != p2) { er.textContent = "The two passwords do not match."; return; }
      sv2.disabled = true;
      const { error } = await sb.auth.updateUser({ password: p1 });
      sv2.disabled = false;
      if (error) { er.textContent = "Could not save the password: " + (error.message || "try again"); return; }
      toast("Password saved"); viewAccount();
    }
  });
  document.addEventListener("click", e => {
    if (e.target.closest("[data-phone]")) { loginMode = "phone"; viewLoginPhone(after); }
  });
  const sendOtpEmail = async function () {
    const nm = $("#ln").value.trim(), em = $("#le").value.trim().toLowerCase();
    if (!nm || !/^\S+@\S+\.\S+$/.test(em)) { $("#err").textContent = "Enter your name and a valid email address."; return; }
    const { error } = await sb.auth.signInWithOtp({ email: em, options: { data: { name: nm } } });
    if (error) { $("#err").textContent = "Could not send code: " + (error.message || "unknown error"); return; }
    tmpU = { nm, em, ph: "" };
    resendAt = Date.now() + 60000;
    open(head("Enter code") + `<div class="lg-hero"><h2>Check your email</h2><p>We sent a login code to <b>${safe(em)}</b>. Check your inbox and spam folder.</p></div><div class="box"><label class="l" for="ot">Enter the code</label>${otpBox(OTP_LEN)}<div class="err" id="err" role="alert"></div><div style="display:flex;justify-content:space-between"><button class="lnk" data-resend>Resend code</button><button class="lnk" data-chg>Change email</button></div></div><button class="big" data-ver>Verify and continue</button>`, "l2");
    otpFocus();
  };
  let resendAt = 0;
  document.addEventListener("click", async e => {
    if (e.target.closest("[data-chg]")) { viewLogin(after); return; }
    if (!e.target.closest("[data-resend]") || !tmpU || !tmpU.em) return;
    if (Date.now() < resendAt) { toast("Please wait " + Math.ceil((resendAt - Date.now()) / 1000) + " seconds"); return; }
    const { error } = await sb.auth.signInWithOtp({ email: tmpU.em, options: { data: { name: tmpU.nm } } });
    if (error) { toast("Could not resend the code"); return; }
    resendAt = Date.now() + 60000; toast("Code sent again");
  });
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

  // ---------- Storefront: photo gallery, details, out of stock ----------
  const _vp = viewProduct;
  viewProduct = function (id) {
    _vp(id);
    const p = find(id); if (!p) return;
    const sh = document.getElementById("sheet"), box = sh.querySelector(".box"), dp = sh.querySelector(".dp");
    if (dp && p.imgs && p.imgs.length > 1) dp.outerHTML = `<div style="display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;margin-bottom:10px">${p.imgs.map(u => `<img src="${safe(u)}" alt="" style="flex:none;width:100%;max-height:360px;object-fit:cover;border-radius:12px;scroll-snap-align:center">`).join("")}</div>`;
    if (!box) return;
    const td = `padding:3px 10px 3px 0;vertical-align:top`;
    const spec = (p.spec || []).filter(x => x && x.k).map(x => `<tr><td style="${td};color:var(--muted)">${safe(x.k)}</td><td style="${td}">${safe(x.v || "")}</td></tr>`);
    if (p.mat) spec.unshift(`<tr><td style="${td};color:var(--muted)">Material</td><td style="${td}">${safe(p.mat)}</td></tr>`);
    const info = [p.deliv ? "Delivery: " + safe(p.deliv) : "", p.ret > 0 ? p.ret + "-day returns" : p.ret === 0 ? "No returns on this product" : ""].filter(Boolean).join(" · ");
    box.insertAdjacentHTML("beforeend", (p.oos ? `<p style="color:var(--bad);font-weight:700">Out of stock</p>` : "") + (p.desc ? `<p style="white-space:pre-line">${safe(p.desc)}</p>` : "") + (spec.length ? `<table style="font-size:.88rem;border-collapse:collapse">${spec.join("")}</table>` : "") + (info ? `<p class="muted">${info}</p>` : ""));
    if (p.oos) { const two = sh.querySelector(".two"); if (two) two.innerHTML = `<button class="big" disabled style="opacity:.55">Out of stock</button>`; }
  };

  // ---------- Customer reviews (only after the order is delivered) ----------
  const stars = n => "★".repeat(n) + "☆".repeat(5 - n);
  const ratingText = id => { const x = RTM[id]; return x ? "★ " + x.avg_rating + " (" + x.review_count + ")" : "No ratings yet"; };
  let rvStar = 0;
  const canReview = pid => !!user && (orders || []).some(o => o.status == "delivered" && (o.items || []).some(i => String(i.id) == String(pid)));
  const _vp2 = viewProduct;
  viewProduct = function (id) {
    _vp2(id);
    const p = find(id); if (!p) return;
    const box = document.querySelector("#sheet .box"); if (!box) return;
    const x = RTM[p.id];
    box.insertAdjacentHTML("beforeend", `<div id="rvbox" data-pid="${safe(String(p.id))}" style="margin-top:14px;border-top:1px solid #ddd;padding-top:10px"><b>Customer reviews</b>${x ? ` <span style="color:#E0A100">★ ${x.avg_rating}</span> <span class="muted">(${x.review_count})</span>` : ""}<div id="rvlist" data-pid="${safe(String(p.id))}" class="muted">Loading…</div><div id="rvform">${canReview(p.id) ? `<button class="big alt" style="margin-top:8px" data-rvopen>Write a review</button>` : `<p class="muted">Only customers whose order is delivered can write a review.</p>`}</div></div>`);
    drawReviews(p.id);
  };
  async function drawReviews(pid) {
    const { data, error } = await sb.from("reviews").select("id,user_id,name,rating,comment,created_at").eq("product_id", pid).order("created_at", { ascending: false }).limit(30);
    const l = document.getElementById("rvlist");
    if (!l || l.dataset.pid != pid) return;
    if (error) { const b = document.getElementById("rvbox"); if (b) b.remove(); return; } // reviews table not created yet
    const { data: { session } } = await sb.auth.getSession();
    const me = session ? session.user.id : null;
    l.className = "";
    l.innerHTML = data.length ? data.map(r => `<div style="border-top:1px solid #eee;padding:8px 0"><b>${safe(r.name)}</b> <span style="color:#E0A100">${stars(r.rating)}</span><br><span class="muted">${new Date(r.created_at).toLocaleDateString("en-IN")}</span>${r.comment ? `<p style="white-space:pre-line;margin:4px 0">${safe(r.comment)}</p>` : ""}${(isAdmin || r.user_id == me) ? `<button class="lnk" data-rvdel="${r.id}">Delete</button>` : ""}</div>`).join("") : `<p class="muted">No reviews yet.</p>`;
  }
  document.addEventListener("click", async e => {
    const bx = document.getElementById("rvbox");
    const st = e.target.closest("[data-star]");
    if (st) {
      rvStar = +st.dataset.star;
      document.querySelectorAll("#rvst [data-star]").forEach(b => { b.style.color = +b.dataset.star <= rvStar ? "#E0A100" : "#ccc"; });
      return;
    }
    const op = e.target.closest("[data-rvopen]");
    if (op && bx) {
      rvStar = 0; op.hidden = true;
      document.getElementById("rvform").insertAdjacentHTML("beforeend", `<div id="rvst" style="margin-top:8px">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}" aria-label="${n} star" style="background:none;border:0;font-size:1.9rem;padding:0 4px;color:#ccc;cursor:pointer">★</button>`).join("")}</div><textarea class="f" id="rvc" rows="3" maxlength="500" placeholder="Write your review (optional)" aria-label="Review"></textarea><div class="err" id="rverr" role="alert"></div><button class="big" data-rvsend>Submit review</button>`);
      return;
    }
    const send = e.target.closest("[data-rvsend]");
    if (send && bx) {
      const pid = bx.dataset.pid, err = document.getElementById("rverr");
      if (!rvStar) { err.textContent = "Please tap the stars to give a rating."; return; }
      send.disabled = true;
      const { error } = await sb.from("reviews").upsert({ product_id: pid, name: (user && user.nm) || "Customer", rating: rvStar, comment: document.getElementById("rvc").value.trim().slice(0, 500) }, { onConflict: "product_id,user_id" });
      if (error) { send.disabled = false; err.textContent = error.code == "42501" ? "Only customers with a delivered order can review this product." : "Could not save review: " + (error.message || "try again"); return; }
      toast("Thanks for your review");
      await loadProducts(true);
      viewProduct(pid);
      return;
    }
    const del = e.target.closest("[data-rvdel]");
    if (del && bx) {
      if (!confirm("Delete this review?")) return;
      const pid = bx.dataset.pid;
      const { error } = await sb.from("reviews").delete().eq("id", del.dataset.rvdel);
      if (error) { toast("Could not delete"); return; }
      toast("Review deleted");
      await loadProducts(true);
      viewProduct(pid);
    }
  });

  // ---------- Seller: product manager ----------
  const AD = { list: [], q: "", st: "all", so: "new", n: 10 };
  const STL = { draft: "Draft", active: "Active", out_of_stock: "Out of stock" };
  const stockOf = p => { const v = (p.product_variants || []).filter(x => x.active); return v.length ? v.reduce((a, x) => a + x.stock, 0) : null; };
  const BACK = `<p><button class="lnk" data-pback>‹ Back to seller panel</button></p>`;
  viewAdmin = function () {
    if (!isAdmin) { viewPin(); return; }
    open(head("Seller panel") + `<div class="box"><button class="big" data-pl>Products</button><br><br><button class="big alt" data-pn>Add product</button><br><br><button class="big" data-sord>View orders</button></div><p class="muted">Changes here go live for all customers.</p>`, "ad");
  };
  async function viewProducts() {
    if (!isAdmin) return;
    open(head("Products") + BACK + `<div class="box"><input class="f" id="apq" placeholder="Search name, SKU, brand" aria-label="Search products" value="${safe(AD.q)}"><div class="two" style="margin-top:8px"><select id="apst" aria-label="Status"><option value="all">All status</option><option value="active">Active</option><option value="draft">Draft</option><option value="out_of_stock">Out of stock</option></select><select id="apso" aria-label="Sort"><option value="new">Newest</option><option value="az">Name A–Z</option><option value="lo">Price low–high</option><option value="hi">Price high–low</option><option value="stock">Lowest stock</option></select></div></div><div id="apitems" class="muted">Loading…</div><button class="big" data-pm hidden id="apmore">Load more</button><br><button class="big alt" data-pn>Add product</button>`, "apl");
    $("#apst").value = AD.st; $("#apso").value = AD.so;
    const { data, error } = await sb.from("products").select("id,sku,name,brand,category,price,mrp,status,featured,image_url,created_at,product_variants(stock,active)").order("created_at", { ascending: false });
    if (error) { $("#apitems").textContent = "Could not load products: " + error.message; return; }
    AD.list = data; AD.n = 10; drawItems();
  }
  function drawItems() {
    const q = AD.q.toLowerCase(), so = AD.so;
    let l = AD.list.filter(p => (AD.st == "all" || p.status == AD.st) && (!q || (p.name + " " + p.sku + " " + p.brand + " " + p.category).toLowerCase().includes(q)));
    l = [...l].sort((a, b) => (so == "lo" ? a.price - b.price : so == "hi" ? b.price - a.price : so == "az" ? a.name.localeCompare(b.name) : so == "stock" ? (stockOf(a) ?? 1e9) - (stockOf(b) ?? 1e9) : 0) || b.id - a.id);
    const total = l.length; l = l.slice(0, AD.n);
    $("#apitems").innerHTML = l.length ? l.map(p => { const s = stockOf(p); return `<div class="box"><div class="line" style="border:0;padding:0"><div class="t" style="background:#E6EEFD">${p.image_url ? `<img src="${safe(p.image_url)}" alt="">` : "📦"}</div><div class="n"><b>${safe(p.name)}</b>${p.featured ? " ⭐" : ""}<br><span class="muted">${safe(p.sku || "")} · ${safe(p.category)}</span><br>${inr(p.price)} · Stock: ${s == null ? "—" : s} · <b>${STL[p.status] || p.status}</b><br><span class="muted">${ratingText(p.id)}</span></div></div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="sz" data-pe="${p.id}">Edit</button><button class="sz" data-pd="${p.id}">Duplicate</button><button class="sz" data-pt="${p.id}">${p.status == "active" ? "Unpublish" : "Publish"}</button><button class="sz" data-pcl="${p.id}">Copy link</button><button class="sz" data-px="${p.id}">Delete</button></div></div>`; }).join("") : `<div class="box">No products found.</div>`;
    const more = $("#apmore"); if (more) more.hidden = total <= AD.n;
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-pcl]"); if (!b) return;
    const it = AD.list.find(x => String(x.id) == b.dataset.pcl);
    copyLink(location.origin + location.pathname + "?p=" + encodeURIComponent(b.dataset.pcl), it && it.status != "active" ? "Link copied. This product is not published yet, so customers cannot see it." : "");
  });
  async function loadFull(id) {
    const { data, error } = await sb.from("products").select("*, product_images(url,position,is_main), product_variants(*), product_costs(supplier_cost)").eq("id", id).single();
    if (error || !data) { toast("Could not open product"); return null; }
    return data;
  }
  let ED = null;
  function toED(d) {
    const imgs = d ? (d.product_images || []).slice().sort((a, b) => ((b.is_main ? 1 : 0) - (a.is_main ? 1 : 0)) || (a.position - b.position)).map((x, i) => ({ url: x.url, main: i == 0 })) : [];
    if (d && !imgs.length && d.image_url) imgs.push({ url: d.image_url, main: true }); // older products only had one photo
    return { id: d ? d.id : null, images: imgs, uploading: false, variants: d ? (d.product_variants || []).map(v => ({ id: v.id, colour: v.colour || "", size: v.size || "", stock: v.stock, price: v.price || "", sku: v.sku || "" })) : [] };
  }
  const val = x => x == null ? "" : safe(x);
  function viewEditor(d) {
    ED = toED(d);
    const c = d ? (Array.isArray(d.product_costs) ? d.product_costs[0] : d.product_costs) : null;
    const cats = CATS.filter(x => x[0] != "All").map(x => `<option${d && d.category == x[0] ? " selected" : ""}>${x[0]}</option>`).join("");
    const opt = (list, cur) => list.map(([v, t]) => `<option value="${v}"${cur == v ? " selected" : ""}>${t}</option>`).join("");
    const f = (lab, id, v, extra) => `<label class="l" for="${id}">${lab}</label><input class="f" id="${id}" value="${val(v)}" ${extra || ""}>`;
    open(head(d && d.id ? "Edit product" : d ? "Duplicate product" : "Add product") + `<p><button class="lnk" data-pl>‹ Back to products</button></p>
    <div class="box"><b>Basics</b>${f("Product name", "en", d && d.name)}${f("Brand", "eb", d && d.brand)}${f("SKU (leave empty to create automatically)", "esku", d && d.sku)}
    <label class="l" for="ec">Category</label><select id="ec">${cats}</select>${f("Subcategory", "esub", d && d.subcategory)}
    <label class="l" for="eaud">Audience</label><select id="eaud">${opt([["", "Not set"], ["Men", "Men"], ["Women", "Women"], ["Kids", "Kids"], ["Unisex", "Unisex"]], d && d.audience || "")}</select>
    <label class="l" for="ed">Description</label><textarea class="f" id="ed" rows="4">${val(d && d.description)}</textarea>
    ${f("Material or fabric", "emat", d && d.material)}${f("Tags (comma separated)", "etags", d && (d.tags || []).join(", "))}
    <label class="l" for="espec">Specifications (one per line, like  Fit: Regular)</label><textarea class="f" id="espec" rows="3">${val(d && (d.specs || []).map(x => x.k + ": " + x.v).join("\n"))}</textarea></div>
    <div class="box"><b>Price</b><div class="two"><div style="flex:1">${f("Selling price ₹", "ep", d && d.price, 'inputmode="numeric"')}</div><div style="flex:1">${f("MRP ₹", "em", d && d.mrp, 'inputmode="numeric"')}</div></div><p id="edisc" class="off"></p>
    ${f("Supplier cost ₹ (only you can see this)", "ecost", c && c.supplier_cost, 'inputmode="numeric"')}</div>
    <div class="box"><b>Photos</b><p class="muted">The first photo marked ★ is the main photo. JPG, PNG or WebP, up to 10 MB each, 8 photos.</p><div id="edimgs"></div><input type="file" id="edfile" accept="image/jpeg,image/png,image/webp" multiple class="f"><div id="edup" class="muted"></div></div>
    <div class="box"><b>Colours, sizes and stock</b><div id="edvars"></div><button class="sz" data-va>+ Add variant</button>
    <p class="muted" style="margin-top:10px">Quick add: colours × sizes</p><div class="two"><input class="f" id="qc" placeholder="Black, White"><input class="f" id="qs" placeholder="S, M, L"><input class="f" id="qk" placeholder="Stock" inputmode="numeric" style="max-width:90px"></div><button class="sz" data-vq style="margin-top:6px">Create all combinations</button></div>
    <div class="box"><b>Delivery, returns and visibility</b>${f("Delivery estimate", "edel", d ? d.delivery_estimate : "3 to 5 days")}${f("Return days (0 = no returns)", "eret", d ? d.return_days : 7, 'inputmode="numeric"')}
    <label class="l" for="est">Status</label><select id="est">${opt([["draft", "Draft (hidden)"], ["active", "Active (live)"], ["out_of_stock", "Out of stock (shown, can not be bought)"]], d && d.id ? d.status : "draft")}</select>
    <label class="pay"><input type="checkbox" id="efeat"${d && d.featured ? " checked" : ""}> Featured product (shown first)</label></div>
    <div class="err" id="err" role="alert"></div><button class="big" data-psave>Save product</button>`, "ed");
    drawImgs(); drawVars(); discUpdate();
  }
  const discUpdate = () => { const p = +($("#ep") || {}).value, m = +($("#em") || {}).value, el = $("#edisc"); if (el) el.textContent = p > 0 && m >= p ? Math.round((1 - p / m) * 100) + "% off" : ""; };
  function drawImgs() {
    $("#edimgs").innerHTML = ED.images.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">${ED.images.map((x, i) => `<div style="width:92px"><img src="${safe(x.url)}" alt="" style="width:92px;height:92px;object-fit:cover;border-radius:10px;border:3px solid ${x.main ? "var(--brand)" : "transparent"}"><div style="display:flex;justify-content:space-between;margin-top:4px">${[["main", "★"], ["up", "◀"], ["down", "▶"], ["del", "✕"]].map(([a, t]) => `<button class="sz" data-ia="${a}" data-ii="${i}" aria-label="${a}" style="min-width:0;padding:2px 7px">${t}</button>`).join("")}</div></div>`).join("")}</div>` : `<p class="muted">No photos yet.</p>`;
  }
  function syncVars() {
    const rows = [...document.querySelectorAll("#edvars .vrow")];
    if (rows.length != ED.variants.length) return;
    rows.forEach((r, i) => { const g = k => r.querySelector(`[data-vf="${k}"]`).value.trim(); Object.assign(ED.variants[i], { colour: g("colour"), size: g("size"), stock: g("stock"), price: g("price") }); });
  }
  function drawVars() {
    $("#edvars").innerHTML = ED.variants.length ? ED.variants.map((v, i) => `<div class="vrow" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--line)"><input class="f" data-vf="colour" placeholder="Colour" value="${val(v.colour)}"><input class="f" data-vf="size" placeholder="Size" value="${val(v.size)}"><input class="f" data-vf="stock" placeholder="Stock" inputmode="numeric" value="${val(v.stock)}"><input class="f" data-vf="price" placeholder="Own price (optional)" inputmode="numeric" value="${val(v.price)}"><button class="sz" data-vx="${i}" style="grid-column:1/3">Remove</button></div>`).join("") : `<p class="muted">No variants. Add them if the product has colours or sizes, or if you want to track stock.</p>`;
  }
  const JPG = ["image/jpeg", "image/png", "image/webp"];
  const toJpeg = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = rej; fr.onload = () => { const im = new Image(); im.onerror = rej; im.onload = () => { const k = Math.min(1, 1200 / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); c.toBlob(b => b ? res(b) : rej(new Error("compress")), "image/jpeg", .82); }; im.src = fr.result; }; fr.readAsDataURL(f); });
  async function addFiles(files) {
    const up = $("#edup"); ED.uploading = true;
    let i = 0;
    for (const f of files) {
      i++;
      if (ED.images.length >= 8) { up.textContent = "Maximum 8 photos."; break; }
      if (!JPG.includes(f.type)) { up.textContent = f.name + ": only JPG, PNG or WebP photos are allowed."; continue; }
      if (f.size > 10 * 1024 * 1024) { up.textContent = f.name + ": the photo is bigger than 10 MB."; continue; }
      up.textContent = `Uploading photo ${i} of ${files.length}…`;
      try {
        const blob = await toJpeg(f), path = `p/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const r = await sb.storage.from("product-images").upload(path, blob, { contentType: "image/jpeg" });
        if (r.error) throw r.error;
        ED.images.push({ url: sb.storage.from("product-images").getPublicUrl(path).data.publicUrl, main: ED.images.length == 0 });
        drawImgs();
      } catch (e) { up.textContent = f.name + ": upload failed. Please try again."; }
    }
    if (up.textContent.startsWith("Uploading")) up.textContent = "Photos ready.";
    ED.uploading = false;
  }
  async function saveEditor() {
    syncVars();
    const g = id => document.getElementById(id).value.trim(), err = m => { $("#err").textContent = m; };
    const price = +g("ep"), mrp = +g("em"), status = g("est"), cost = g("ecost");
    if (ED.uploading) return err("Please wait for the photos to finish uploading.");
    if (!g("en") || !g("eb") || !g("ec")) return err("Name, brand and category are required.");
    if (!(price > 0) || !(mrp >= price)) return err("Enter a selling price above 0. The MRP must not be lower than the selling price.");
    if (cost !== "" && !(+cost >= 0)) return err("Supplier cost must be a number.");
    if (status == "active" && !ED.images.length) return err("Add at least one photo before publishing.");
    const seen = new Set();
    for (const v of ED.variants) {
      if (!v.colour && !v.size) return err("Each variant needs a colour or a size.");
      const k = (v.colour + "|" + v.size).toLowerCase(); if (seen.has(k)) return err("Duplicate variant: " + v.colour + " " + v.size); seen.add(k);
      if (!/^\d+$/.test(String(v.stock))) return err("Stock must be a whole number, 0 or more (variant " + v.colour + " " + v.size + ").");
      if (v.price !== "" && !(+v.price > 0)) return err("Variant price must be a number above 0.");
    }
    const payload = {
      id: ED.id, name: g("en"), brand: g("eb"), sku: g("esku"), category: g("ec"), subcategory: g("esub"), description: g("ed"), material: g("emat"), audience: g("eaud"),
      tags: g("etags").split(",").map(x => x.trim()).filter(Boolean),
      specs: g("espec").split("\n").map(l => { const i = l.indexOf(":"); return i > 0 ? { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() } : null; }).filter(Boolean),
      delivery_estimate: g("edel"), return_days: parseInt(g("eret"), 10) || 0, featured: document.getElementById("efeat").checked, status, price, mrp, supplier_cost: cost === "" ? null : +cost,
      images: ED.images.map(x => ({ url: x.url, is_main: !!x.main })),
      variants: ED.variants.map(v => ({ id: v.id || null, colour: v.colour, size: v.size, sku: v.sku, stock: +v.stock, price: v.price === "" ? null : +v.price, active: true }))
    };
    const btn = document.querySelector("[data-psave]"); btn.disabled = true;
    const { error } = await sb.rpc("admin_save_product", { p: payload });
    if (error) { btn.disabled = false; return err(/products_sku_key/.test(error.message) ? "This SKU is already used by another product." : "Could not save: " + error.message); }
    toast("Product saved"); loadProducts(true); viewProducts();
  }
  document.addEventListener("click", async e => {
    const t = e.target.closest("button"); if (!t || !isAdmin) return; const d = t.dataset;
    if (d.pback !== undefined) viewAdmin();
    else if (d.pl !== undefined) viewProducts();
    else if (d.pn !== undefined) viewEditor(null);
    else if (d.pm !== undefined) { AD.n += 10; drawItems(); }
    else if (d.pe) { const p = await loadFull(d.pe); if (p) viewEditor(p); }
    else if (d.pd) { const p = await loadFull(d.pd); if (p) viewEditor({ ...p, id: null, name: p.name + " (Copy)", sku: "", status: "draft", featured: false, product_variants: (p.product_variants || []).map(v => ({ ...v, id: undefined, sku: "" })) }); }
    else if (d.pt) {
      const p = AD.list.find(x => String(x.id) == d.pt); if (!p) return;
      const ns = p.status == "active" ? "draft" : "active";
      if (ns == "active" && !p.image_url) return toast("Add a photo first (tap Edit)");
      const { error } = await sb.from("products").update({ status: ns }).eq("id", p.id);
      if (error) return toast("Could not change status");
      p.status = ns; drawItems(); loadProducts(true);
    }
    else if (d.px) {
      if (!confirm("Delete this product? This can not be undone.")) return;
      const { error } = await sb.from("products").delete().eq("id", d.px);
      if (error) return toast("Could not delete");
      AD.list = AD.list.filter(x => String(x.id) != d.px); drawItems(); loadProducts(true); toast("Product deleted");
    }
    else if (d.ia) {
      const i = +d.ii, a = d.ia, L = ED.images;
      if (a == "main") L.forEach((x, k) => x.main = k == i);
      else if (a == "up" && i > 0) [L[i - 1], L[i]] = [L[i], L[i - 1]];
      else if (a == "down" && i < L.length - 1) [L[i + 1], L[i]] = [L[i], L[i + 1]];
      else if (a == "del") { const wasMain = L[i].main; L.splice(i, 1); if (wasMain && L.length) L[0].main = true; }
      drawImgs();
    }
    else if (d.va !== undefined) { syncVars(); ED.variants.push({ id: null, colour: "", size: "", stock: "0", price: "", sku: "" }); drawVars(); }
    else if (d.vx !== undefined) { syncVars(); ED.variants.splice(+d.vx, 1); drawVars(); }
    else if (d.vq !== undefined) {
      syncVars();
      const cs = $("#qc").value.split(",").map(x => x.trim()).filter(Boolean), ss = $("#qs").value.split(",").map(x => x.trim()).filter(Boolean), k = $("#qk").value.trim() || "0";
      if (!/^\d+$/.test(k) || (!cs.length && !ss.length)) return toast("Enter colours and/or sizes, and a whole number for stock");
      const have = new Set(ED.variants.map(v => (v.colour + "|" + v.size).toLowerCase()));
      (cs.length ? cs : [""]).forEach(c => (ss.length ? ss : [""]).forEach(s => { const key = (c + "|" + s).toLowerCase(); if (!have.has(key)) { have.add(key); ED.variants.push({ id: null, colour: c, size: s, stock: k, price: "", sku: "" }); } }));
      drawVars();
    }
    else if (d.psave !== undefined) saveEditor();
  });
  document.addEventListener("input", e => {
    if (e.target.id == "apq") { AD.q = e.target.value; drawItems(); }
    else if (e.target.id == "ep" || e.target.id == "em") discUpdate();
  });
  document.addEventListener("change", e => {
    if (e.target.id == "apst") { AD.st = e.target.value; drawItems(); }
    else if (e.target.id == "apso") { AD.so = e.target.value; drawItems(); }
    else if (e.target.id == "edfile" && e.target.files.length) { addFiles([...e.target.files]); e.target.value = ""; }
  });

  viewPin = function () {
    if (isAdmin) { viewAdmin(); return; }
    open(head("Seller login") + `<div class="box">${user ? "This account is not a seller account." : "Log in with your seller mobile number first, then tap Seller login again."}</div><button class="big" data-close>OK</button>`, "s");
  };
  delProduct = async function (id) {
    if (!isAdmin) return;
    const { error } = await sb.from("products").delete().eq("id", id);
    if (error) { toast("Could not remove"); return; }
    await loadProducts(true); viewAdmin();
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
    await loadProducts(true); toast("Product added"); viewAdmin();
  };

  async function done(res, py, nm, ad, pn) {
    const d = new Date(Date.now() + 4 * 864e5).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    const L = lines(); // read the items before the cart is emptied
    if (window.track) track("purchase", { transaction_id: String(res.order_no), value: res.total, currency: "INR", items: L.map(({ p, q }) => ({ item_id: String(p.id), item_name: p.n, price: p.p, quantity: q })) });
    cart = {}; coupon = ""; save(); render(); await loadOrders();
    const cod = py == "Cash on delivery";
    const col = ["#FFB400", "#FF7A00", "#ffffff", "#7FB2FF", "#FFE08A", "#B7F0D2"];
    const cf = Array.from({ length: 18 }, (_, i) => { const a = (i / 18) * 6.283 + (i % 3) * .2, r = 70 + (i % 4) * 22; return `<i style="--x:${Math.round(Math.cos(a) * r)}px;--y:${Math.round(Math.sin(a) * r * .8)}px;--c:${col[i % col.length]}"></i>`; }).join("");
    const items = L.map(({ p, sz, q }) => `<div class="os-i"><div class="os-t" style="background:${p.bg}">${p.e}</div><div class="os-n">${safe(p.n)}${sz ? " · " + safe(sz) : ""}<br><span class="muted">Qty ${q}</span></div><b>${inr(p.p * q)}</b></div>`).join("");
    open(head("Order placed") +
      `<div class="os-hero"><svg class="os-ck" viewBox="0 0 52 52" aria-hidden="true"><circle class="c" cx="26" cy="26" r="24"/><path d="M15 27l8 8 14-16"/></svg><div class="os-cf" aria-hidden="true">${cf}</div><h2>Order placed!</h2><p>Thank you${nm ? ", " + safe(nm.split(" ")[0]) : ""}. Your order is confirmed.</p><div class="os-no">Order ID ${safe(res.order_no)}</div></div>` +
      `<div class="box os-del"><span style="font-size:1.8rem">🚚</span><div><b>Delivery by ${d}</b><br><span class="muted">${cod ? "Pay " + inr(res.total) + " in cash when it arrives" : "Paid " + inr(res.total) + " online"}</span></div></div>` +
      (items ? `<div class="box"><b>Items in this order</b>${items}</div>` : "") +
      `<div class="box"><b>Delivering to</b><br>${safe(nm)}<br><span class="muted">${safe(ad)} – ${safe(pn)}</span></div>` +
      `<div class="box"><div class="row"><span>Payment</span><span>${cod ? "Cash on delivery" : "Online payment"}</span></div><div class="row t2"><span>${cod ? "To pay" : "Paid"}</span><span>${inr(res.total)}</span></div></div>` +
      `<button class="big" data-track="${safe(res.order_no)}">Track order</button><br><button class="sz" data-close style="width:100%;border-radius:12px;padding:12px">Continue shopping</button>`, "d");
  }
  pay = async function () {
    const A = window.__ADDR || {}, nm = A.nm || "", ph = A.ph || "", ad = A.ad || "", pn = A.pn || "";
    if (!nm || !/^[6-9]\d{9}$/.test(ph) || ad.length < 6 || !/^\d{6}$/.test(pn)) { toast("Please check your delivery address"); viewCheckout(); return; }
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
      H("On your device") + `<p>The site saves your cart and login on your device so they are there when you come back.${(window.VELOR4_EXTRA && window.VELOR4_EXTRA.GA_ID) ? " We also use Google Analytics to count visits and see which pages and products are popular. It collects usage data, not your name or address." : ""}</p>` +
      H("Your choices") + `<p>To see or correct your information, email ${mail}. You can delete your account any time from My account.</p>`) },
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

// ---------- Install as an app (PWA) ----------
(() => {
  const hd = document.head;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k])); hd.appendChild(el); };
  add("link", { rel: "manifest", href: "manifest.json" });
  add("meta", { name: "theme-color", content: "#1546B0" });
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
    { t: "Free delivery over ₹499", s: "Cash on delivery on every order", bg: "linear-gradient(120deg,#1546B0,#2F6FED)" },
    { t: "7-day easy returns", s: "Shop without worry", bg: "linear-gradient(120deg,#0E7C66,#27B98F)" },
    { t: "Advertise your brand here", s: "Email us to book this space", bg: "linear-gradient(120deg,#C2410C,#F59E0B)", tag: "Sponsored", link: "mailto:riyaenterprises77150@gmail.com" }
  ];
  const css = `
:root{--bg:#F2F5FB;--surface:#fff;--ink:#14213D;--muted:#5F6B85;--line:#E1E8F4;--brand:#1A56DB;--brand2:#FF7A00;--on:#fff;--soft:#E6EEFD;--ok:#12805C;--bad:#E5484D}
body{background:var(--bg);padding-bottom:calc(72px + env(safe-area-inset-bottom,0px))}
body::before{background:#1546B0}
header{background:linear-gradient(135deg,#1546B0,#2F6FED);border:0;padding:12px 14px 16px;border-radius:0 0 22px 22px;box-shadow:0 6px 20px rgba(21,70,176,.25)}
.logo{color:#fff;letter-spacing:-1px}
.logo b{background:#FF7A00;color:#1F1000;border-radius:8px}
.ib{background:#fff;border:0;color:#1546B0}
.ib i{background:#E5484D;color:#fff}
.search{background:#fff;border:0;border-radius:14px;padding:13px 16px;color:#14213D;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.cats{background:#fff;padding:10px 6px 0;gap:0;margin-top:-6px;border-bottom:1px solid var(--line)}
.cat{color:var(--ink);width:78px;padding:4px 0 8px;border-bottom:3px solid transparent;font-size:.76rem}
.cat span{width:46px;height:46px;border-radius:14px;background:var(--soft);border:0;box-shadow:none;font-size:1.65rem}
.cat[aria-pressed="true"]{color:var(--brand);border-bottom-color:var(--brand);font-weight:800}
.cat[aria-pressed="true"] span{background:#D6E4FF}
.cw{flex:none;display:flex;margin:0 -14px -16px;min-height:calc(100vh - 90px);background:#fff}
.crl{flex:0 0 90px;background:var(--bg);border-right:1px solid var(--line)}
.cr{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;border:0;background:none;padding:12px 4px;font-size:.72rem;font-weight:600;color:var(--muted);border-left:4px solid transparent}
.cr span{font-size:1.7rem;line-height:1}
.cr[aria-pressed="true"]{background:#fff;color:var(--brand);border-left-color:var(--brand)}
.crp{flex:1;min-width:0;padding:12px}
.crp h3{margin:0 0 10px;font-size:1rem}
.cg{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.ct2{border:0;background:none;display:flex;flex-direction:column;gap:3px;text-align:left;font-size:.78rem;color:var(--ink);padding:0}
.cpic{aspect-ratio:1;border-radius:14px;display:grid;place-items:center;font-size:2.4rem;overflow:hidden}
.cpic img{width:100%;height:100%;object-fit:cover}
.ct2 span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--muted)}
.ct2 b{font-size:.9rem}
.os-hero{flex:none;position:relative;margin:0 -14px 12px;padding:26px 18px 24px;text-align:center;color:#fff;background:linear-gradient(160deg,#0B7A43,#22B573);border-radius:0 0 26px 26px;overflow:hidden}
.os-hero h2{margin:10px 0 4px;font-size:1.5rem}
.os-hero p{margin:0;opacity:.95}
.os-no{display:inline-block;margin-top:12px;background:rgba(255,255,255,.2);border-radius:999px;padding:5px 14px;font-weight:700;font-size:.85rem}
.os-ck{width:84px;height:84px;display:block;margin:0 auto}
.os-ck .c{fill:#fff}
.os-ck path{fill:none;stroke:#0B7A43;stroke-width:4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:40;stroke-dashoffset:40;animation:osd .5s .35s ease-out forwards}
.os-ck .c{transform-origin:center;animation:osp .45s ease-out}
@keyframes osd{to{stroke-dashoffset:0}}
@keyframes osp{from{transform:scale(.3);opacity:0}to{transform:scale(1);opacity:1}}
.os-cf{position:absolute;left:50%;top:68px;width:0;height:0}
.os-cf i{position:absolute;width:8px;height:8px;border-radius:2px;background:var(--c);animation:osf 1.1s .3s ease-out forwards;opacity:0}
@keyframes osf{0%{transform:translate(0,0) scale(.4);opacity:1}100%{transform:translate(var(--x),var(--y)) rotate(200deg) scale(1);opacity:0}}
@media(prefers-reduced-motion:reduce){.os-ck path{animation:none;stroke-dashoffset:0}.os-ck .c{animation:none}.os-cf{display:none}}
.lg-hero{flex:none;margin:0 -14px 12px;padding:22px 18px 24px;color:#fff;background:linear-gradient(135deg,#1546B0,#2F6FED);border-radius:0 0 26px 26px}
.lg-hero h2{margin:0 0 6px;font-size:1.4rem}
.lg-hero p{margin:0;opacity:.95}
.ac-hero{flex:none;margin:0 -14px 12px;padding:20px 18px 24px;color:#fff;background:linear-gradient(135deg,#1546B0,#2F6FED);border-radius:0 0 26px 26px;display:flex;align-items:center;gap:14px}
.ac-av{width:56px;height:56px;border-radius:50%;background:#fff;color:#1546B0;display:grid;place-items:center;font:800 1.5rem Sora,sans-serif;flex:none}
.ac-hero b{font-size:1.2rem;display:block}.ac-hero span{opacity:.92;font-size:.88rem;word-break:break-all}
.ac-grid{flex:none;display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.ac-t{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 12px;font-weight:700;text-align:left;color:var(--ink)}
.ac-t em{font-style:normal;font-size:1.4rem}
.ac-list{flex:none;background:#fff;border-radius:16px;overflow:hidden;margin-bottom:12px}
.ac-row{display:flex;align-items:center;gap:12px;width:100%;background:none;border:0;border-bottom:1px solid var(--line);padding:14px 14px;text-align:left;color:var(--ink);font-weight:600}
.ac-row:last-child{border-bottom:0}
.ac-row em{font-style:normal;font-size:1.2rem;width:26px;text-align:center}
.ac-row span{flex:1}.ac-row i{font-style:normal;color:var(--muted);font-size:1.3rem}
.ac-h{margin:14px 2px 8px;font-size:.8rem;font-weight:700;letter-spacing:.5px;color:var(--muted);text-transform:uppercase}
.ac-lo{margin:0 0 18px;background:#fff;border:1.5px solid var(--line)!important;color:var(--ink)!important;font-weight:700}
.pg{position:relative;margin-bottom:10px}
.pg .dp{margin-bottom:0;aspect-ratio:1}
.pg-h{position:absolute;top:10px;right:10px;width:40px;height:40px;border-radius:50%;border:0;background:#fff;color:#9AA5BD;font-size:1.2rem;box-shadow:0 2px 8px rgba(0,0,0,.2);display:grid;place-items:center}
.pg-h[aria-pressed="true"]{color:#E5484D}
.pg-s{position:absolute;top:10px;right:60px;width:40px;height:40px;border-radius:50%;border:0;background:#fff;color:#5F6B85;box-shadow:0 2px 8px rgba(0,0,0,.2);display:grid;place-items:center;padding:0}
.pg-s svg{width:20px;height:20px}
.pg-c{position:absolute;right:10px;bottom:10px;background:rgba(0,0,0,.6);color:#fff;font-size:.72rem;padding:3px 9px;border-radius:999px}
.pd-n{font-size:1.05rem;font-weight:600;line-height:1.3}
#sheet .box .pr{margin:6px 0}
#sheet .box .pr b{font-size:1.6rem}
.pd-r{display:flex;gap:12px;align-items:flex-start;padding:10px 0}.pd-r+.pd-r{border-top:1px solid var(--line)}
.pd-r em{font-style:normal;font-size:1.3rem;width:28px;text-align:center}
.pd-h{display:block;margin-bottom:6px}
.pd-d table{width:100%}
#rvbox{margin:0 0 10px!important;border:0!important;padding:12px!important}
.sn{font-size:.76rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-align:left;color:var(--muted)}
#sheet .two>.big:not(.alt){background:#fff;color:var(--ink);border:1px solid var(--line);box-shadow:none}
#sheet .two>.big[disabled]{background:var(--line);color:var(--muted)}
.big.danger{background:#E5484D;box-shadow:none;color:#fff}
.otp{position:relative;margin:10px 0 6px}
.otp-in{position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:16px;border:0;padding:0;z-index:2;caret-color:transparent}
.otp-b{display:flex;gap:6px;justify-content:space-between}
.otp-b i{flex:1;max-width:46px;height:54px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);display:grid;place-items:center;font:700 1.35rem/1 Sora,"Plus Jakarta Sans",sans-serif;font-style:normal;color:var(--ink)}
.otp-b i.on{border-color:var(--brand);background:#fff}
.otp-in:focus ~ .otp-b i.cur{border-color:var(--brand);box-shadow:0 0 0 3px rgba(26,86,219,.18)}
.wafab{position:fixed;right:14px;bottom:calc(82px + env(safe-area-inset-bottom,0px));z-index:7;width:54px;height:54px;border-radius:50%;background:#25D366;display:none;place-items:center;box-shadow:0 4px 14px rgba(0,0,0,.28)}
.wafab svg{width:30px;height:30px}
@media(max-width:699px){.wafab{display:grid}}
.os-del{display:flex;gap:12px;align-items:center}
.os-i{display:flex;gap:10px;align-items:center;padding:8px 0}.os-i+.os-i{border-top:1px solid var(--line)}
.os-t{width:52px;height:52px;border-radius:10px;display:grid;place-items:center;font-size:1.6rem;flex:none;overflow:hidden}
.os-t img{width:100%;height:100%;object-fit:cover}
.os-n{flex:1;min-width:0;font-size:.88rem}
.banner{display:none}
.promo{position:relative;display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:8px 14px 4px;scrollbar-width:none}
.promo::-webkit-scrollbar{display:none}
.slide{flex:0 0 88%;scroll-snap-align:center;border-radius:20px;padding:20px 18px;color:#fff;text-decoration:none;min-height:124px;display:flex;flex-direction:column;justify-content:center;position:relative;background-size:cover;background-position:center}
.slide b{font:800 1.3rem/1.15 Sora,"Plus Jakarta Sans",sans-serif}
.slide.im{aspect-ratio:2.5/1;min-height:0;padding:0}
.slide{cursor:pointer}
.slide span{opacity:.92;font-size:.9rem;margin-top:4px}
.slide em{position:absolute;top:10px;right:12px;font-style:normal;font-size:.65rem;background:rgba(0,0,0,.32);padding:2px 8px;border-radius:999px}
.trust{display:flex;gap:8px;overflow-x:auto;padding:8px 14px 2px;scrollbar-width:none}
.trust::-webkit-scrollbar{display:none}
.trust span{flex:none;background:#fff;border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:.78rem;font-weight:600;color:var(--ink)}
#deals h2{font-size:1.1rem;margin:14px 14px 8px}
.dr{display:flex;gap:10px;overflow-x:auto;padding:0 14px 6px;scrollbar-width:none}
.dr::-webkit-scrollbar{display:none}
.dc{flex:0 0 124px;border:1px solid var(--line);background:#fff;border-radius:14px;padding:8px;text-align:left;display:flex;flex-direction:column;gap:3px}
.dpic{aspect-ratio:1;border-radius:10px;display:grid;place-items:center;font-size:2.6rem;overflow:hidden}
.dpic img{width:100%;height:100%;object-fit:cover}
.dc b{font-size:1rem}.dc span{color:var(--ok);font-weight:700;font-size:.8rem}
.tools{padding-top:16px}.tools h2{font-size:1.15rem}
.card{border:1px solid var(--line);border-radius:14px;box-shadow:none}
.pic{position:relative;border-radius:0}
.bdg{position:absolute;left:8px;top:8px;background:#FF7A00;color:#1F1000;font-weight:800;font-size:.7rem;line-height:1;padding:5px 9px;border-radius:999px}
.body{padding:10px 12px 14px}
.br{font-size:.74rem;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.nm{color:var(--ink);font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pr b{font-size:1.1rem}
.sheet{background:var(--bg);border-radius:24px 24px 0 0}
.big{background:linear-gradient(135deg,#1546B0,#2F6FED);color:#fff;border-radius:14px;box-shadow:0 6px 16px rgba(21,70,176,.28)}
.big.alt{background:#FF7A00;color:#1F1000;box-shadow:none}
.box{border-radius:16px}
.tile{border:0;background:#fff;border-radius:16px;padding:14px 6px;display:flex;flex-direction:column;align-items:center;gap:6px;font-weight:600;box-shadow:0 2px 8px rgba(21,70,176,.08)}
.tile span{font-size:1.8rem}
.lnk{color:var(--muted)}
#bn{position:fixed;left:0;right:0;bottom:0;z-index:8;display:none;background:#fff;border-top:1px solid var(--line);box-shadow:0 -4px 16px rgba(21,70,176,.10);padding:8px 4px calc(6px + env(safe-area-inset-bottom,0px))}
#bn button{position:relative;border:0;background:none;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:.7rem;font-weight:600;color:var(--muted);flex:1;padding:4px 0}
#bn button[aria-current="true"]{color:var(--brand);font-weight:700}
#bn button[aria-current="true"]::before{content:"";position:absolute;top:-8px;width:30px;height:3px;border-radius:0 0 3px 3px;background:var(--brand2)}
#bn em{font-style:normal;font-size:1.35rem;line-height:1}
#bn i{position:absolute;top:-2px;left:calc(50% + 6px);background:#E5484D;color:#fff;font-style:normal;font-size:.65rem;min-width:17px;height:17px;border-radius:9px;display:grid;place-items:center;padding:0 4px}
#bn i[hidden]{display:none}
@media(max-width:699px){#bn{display:flex}.ib{display:none}}
.toast{bottom:calc(88px + env(safe-area-inset-bottom,0px))}`;
  document.documentElement.setAttribute("data-theme", "light");
  const st = document.createElement("style"); st.id = "look-css"; st.textContent = css; document.head.appendChild(st);
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", "#1546B0");

  // promo slides (ads)
  const promo = document.createElement("div"); promo.className = "promo";
  // Slides come from ads.json (easy to edit on GitHub). If it is missing or broken, the list above is used.
  const okUrl = u => typeof u === "string" && (/^(https?:|mailto:|tel:)/i.test(u) || /^[\w./-]+$/.test(u));
  const okBg = v => typeof v === "string" && /^[#a-z0-9(),.%\s-]+$/i.test(v);
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const live = b => b && (!b.start || String(b.start) <= today()) && (!b.end || String(b.end) >= today()); // optional "start"/"end" dates: YYYY-MM-DD
  const okIn = v => typeof v === "string" && /^(product|category):[^<>"'&]{1,60}$/.test(v); // opens inside the store
  const drawPromo = L => L.filter(live).slice(0, 10).map(b => {
    const bg = okBg(b.bg) ? b.bg : "linear-gradient(120deg,#1546B0,#2F6FED)";
    const img = okUrl(b.img) ? String(b.img).replace(/['")\\]/g, "") : "";
    const only = img && !b.t && !b.s; // picture-only banner (text is already inside the picture)
    const st2 = `background:${img ? (only ? "" : "linear-gradient(0deg,rgba(0,0,0,.35),rgba(0,0,0,.1)),") + `url('${img}')` : bg};`;
    const inner = `${b.tag ? `<em>${safe(b.tag)}</em>` : ""}<b>${safe(b.t || "")}</b><span>${safe(b.s || "")}</span>`;
    const cls = "slide" + (only ? " im" : "");
    if (okIn(b.link)) return `<div class="${cls}" role="button" tabindex="0" data-adl="${safe(b.link)}" style="${st2}">${inner}</div>`;
    return okUrl(b.link) ? `<a class="${cls}" href="${String(b.link).replace(/"/g, "")}" style="${st2}">${inner}</a>` : `<div class="${cls}" style="${st2}">${inner}</div>`;
  }).join("");
  document.addEventListener("click", e => {
    const al = e.target.closest("a.slide"); if (al && window.track) track("ad_click", { ad: (al.querySelector("b") || {}).textContent || "" });
    const a = e.target.closest("[data-adl]"); if (!a) return;
    if (window.track) track("ad_click", { ad: (a.querySelector("b") || {}).textContent || "" });
    const i = a.dataset.adl.indexOf(":"), k = a.dataset.adl.slice(0, i), v = a.dataset.adl.slice(i + 1);
    if (k == "product") { const p = find(v); if (p) viewProduct(p.id); }
    else if (k == "category" && CATS.some(c => c[0] == v)) { cat = v; term = ""; const q = document.getElementById("q"); if (q) q.value = ""; render(); const t = document.getElementById("ttl"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); }
  });
  promo.innerHTML = drawPromo(BANNERS);
  fetch("ads.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(L => { if (Array.isArray(L) && L.length) promo.innerHTML = drawPromo(L); }).catch(() => {});
  const ban = document.querySelector(".banner"); if (ban) ban.after(promo);
  const trust = document.createElement("div"); trust.className = "trust";
  trust.innerHTML = "<span>🚚 Free delivery over ₹499</span><span>💵 Cash on delivery</span><span>🏷️ Code VELOR10: 10% off</span>";
  promo.after(trust);
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
  const catRail = sel => CATS.map(([c, e]) => `<button class="cr" data-cr="${c}" aria-pressed="${c == sel}"><span>${e}</span>${c}</button>`).join("");
  const catPane = sel => {
    const l = P.filter(p => sel == "All" || p.c == sel).slice(0, 12);
    return `<h3>${sel == "All" ? "All products" : safe(sel)}</h3>` + (l.length ? `<div class="cg">${l.map(p => `<button class="ct2" data-v="${p.id}"><div class="cpic" style="background:${p.bg}">${p.e}</div><span>${safe(p.n)}</span><b>${inr(p.p)}</b></button>`).join("")}</div>` : `<p class="muted">No products here yet.</p>`) + `<button class="big" data-c="${sel}" data-close style="margin-top:14px">View all</button>`;
  };
  function viewCats(sel) {
    sel = sel || cat;
    open(head("All categories") + `<div class="cw"><div class="crl">${catRail(sel)}</div><div class="crp" id="crp">${catPane(sel)}</div></div>`, "cats");
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-cr]"); if (!b) return;
    document.querySelectorAll(".cr").forEach(x => x.setAttribute("aria-pressed", x == b ? "true" : "false"));
    const pane = document.getElementById("crp"); if (pane) pane.innerHTML = catPane(b.dataset.cr);
  });
  function viewCoupons() {
    open(head("Coupons") + `<div class="box" style="border:2px dashed var(--brand)"><b style="font-size:1.2rem;color:var(--brand)">VELOR10</b><p style="margin:6px 0 0">Get 10% off on your order. Type this code in your cart and tap Apply.</p></div><button class="big" data-close>Continue shopping</button>`, "cp");
  }
  viewAccount = function () {
    if (!user) { viewLogin(); return; }
    const mine = orders.filter(o => o.ph == user.ph), last = mine[0];
    const nm = String(user.nm || "Customer"), ini = safe(nm.trim().charAt(0).toUpperCase() || "C");
    const row = (ic, t, attr) => `<button class="ac-row" ${attr}><em>${ic}</em><span>${t}</span><i>›</i></button>`;
    open(head("My account") +
      `<div class="ac-hero"><div class="ac-av">${ini}</div><div><b>Hi, ${safe(nm)}</b><span>${user.em ? safe(user.em) : user.ph ? "+91 " + safe(user.ph) : ""}</span></div></div>` +
      `<div class="ac-grid"><button class="ac-t" data-ord><em>📦</em>Orders</button><button class="ac-t" data-acw><em>♥</em>Wishlist</button><button class="ac-t" data-accp><em>🏷️</em>Coupons</button><button class="ac-t" data-pol="contact"><em>🎧</em>Help Center</button></div>` +
      (last ? `<div class="box"><b>Your latest order</b><br><span class="muted">${safe(last.no)} · ${new Date(last.t).toLocaleDateString("en-IN")} · ${inr(last.total)}</span><br><b class="${stage(last) == 4 ? "green" : ""}">${STEPS[stage(last)]}</b><br><br><button class="big" data-track="${safe(last.no)}">Track order</button></div>` : `<div class="box">No orders yet. When you order, you can track it here.</div>`) +
      `<div class="ac-h">My activity</div><div class="ac-list">${row("📦", "My orders (" + mine.length + ")", "data-ord")}${row("♥", "My wishlist (" + wish.length + ")", "data-acw")}${row("🏷️", "Coupons", "data-accp")}</div>` +
      `<div class="ac-h">Security</div><div class="ac-list">${row("🔒", "Set or change password", "data-acpw")}</div>` +
      `<div class="ac-h">Help and policies</div><div class="ac-list">${row("🎧", "Contact us", 'data-pol="contact"')}${row("🚚", "Shipping", 'data-pol="shipping"')}${row("↩️", "Returns", 'data-pol="returns"')}${row("🔒", "Privacy", 'data-pol="privacy"')}${row("📄", "Terms", 'data-pol="terms"')}</div>` +
      `<button class="sz ac-lo" data-out style="width:100%;border-radius:14px;padding:14px">Log out</button><button class="lnk" data-delacc style="display:block;margin:0 auto 20px;color:#E5484D">Delete my account</button>`, "a");
  };
  function viewPassword() {
    open(head("Password") + `<div class="box"><b>Set or change password</b><p class="muted">Use at least 8 characters with a small letter, a capital letter, a number and a symbol. After this you can log in with your email and password.</p><label class="l" for="np1">New password</label><div style="position:relative"><input class="f" id="np1" type="password" autocomplete="new-password" style="padding-right:64px"><button type="button" class="lnk" data-eye style="position:absolute;right:10px;top:12px">Show</button></div><label class="l" for="np2">Confirm password</label><input class="f" id="np2" type="password" autocomplete="new-password"><div class="err" id="pwerr" role="alert"></div></div><button class="big" data-pwsave>Save password</button>`, "pw");
  }
  function viewDelAcc() {
    open(head("Delete account") + `<div class="box"><b>Delete your account?</b><p>This will permanently delete:</p><ul style="margin:0 0 8px;padding-left:20px"><li>your login and profile</li><li>your reviews</li></ul><p class="muted">Your past orders are kept in our records for accounting and returns, but they will no longer be linked to a login. You cannot undo this.</p><label class="l" for="delc">Type DELETE to confirm</label><input class="f" id="delc" autocomplete="off" autocapitalize="characters"><div class="err" id="delerr" role="alert"></div></div><button class="big danger" data-delgo>Delete my account</button><br><button class="sz" data-close style="width:100%;border-radius:12px;padding:12px">Keep my account</button>`, "dela");
  }
  function viewShare(d) {
    open(head("Share") + `<div class="box"><b>${safe(d.text)}</b><p class="muted" style="word-break:break-all;margin:6px 0 0">${safe(d.url)}</p></div><a class="big" style="display:block;text-align:center;text-decoration:none;background:#25D366;color:#fff;box-shadow:none" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(d.text + " " + d.url)}">Share on WhatsApp</a><br><button class="sz" data-cpl="${safe(d.url)}" style="width:100%;border-radius:12px;padding:12px">Copy link</button>`, "sh");
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-delacc]")) viewDelAcc();
    if (e.target.closest("[data-acpw]")) viewPassword();
    const c = e.target.closest("[data-cpl]"); if (c) copyLink(c.dataset.cpl);
  });
  document.addEventListener("click", e => {
    if (e.target.closest("[data-acw]")) viewWish();
    else if (e.target.closest("[data-accp]")) viewCoupons();
  });
  // ---------- WhatsApp (switches on when WHATSAPP is set in settings.js) ----------
  const WAN = (() => { let n = String((window.VELOR4_EXTRA || {}).WHATSAPP || "").replace(/\D/g, ""); if (n.length == 10) n = "91" + n; return n.length >= 11 && n.length <= 15 ? n : ""; })();
  const waLink = msg => "https://wa.me/" + WAN + "?text=" + encodeURIComponent(msg);
  const _vpd = viewProduct;
  viewProduct = function (id) {
    _vpd(id);
    const p = find(id); if (!p) return;
    const sh = document.getElementById("sheet"), box = sh.querySelector(".box"); if (!box) return;
    const mk = h => { const d = document.createElement("div"); d.innerHTML = h; return d.firstElementChild; };
    // photo area: heart button and photo counter on top of the picture
    const vis = box.previousElementSibling;
    if (vis && !vis.classList.contains("top")) {
      const g = document.createElement("div"); g.className = "pg";
      vis.before(g); g.appendChild(vis); vis.style.marginBottom = "0";
      const n = p.imgs ? p.imgs.length : 0;
      g.insertAdjacentHTML("beforeend", `<button class="pg-s" data-ps="${p.id}" aria-label="Share this product"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4M8.6 13.4l6.8 4"/></svg></button><button class="pg-h" data-w="${p.id}" aria-pressed="${wish.includes(p.id)}" aria-label="Wishlist">♥</button>` + (n > 1 ? `<span class="pg-c">1/${n}</span>` : ""));
      if (n > 1) vis.addEventListener("scroll", () => { const i = Math.round(vis.scrollLeft / (vis.clientWidth || 1)); const c = g.querySelector(".pg-c"); if (c) c.textContent = (i + 1) + "/" + n; }, { passive: true });
    }
    // title, and remove the old one-line delivery text (replaced by the delivery card)
    if (box.firstElementChild) box.firstElementChild.classList.add("pd-n");
    box.querySelectorAll("p.fd").forEach(x => x.remove());
    [...box.querySelectorAll("p.muted")].forEach(x => { if (/^(Delivery:|\d+-day returns|No returns)/.test(x.textContent.trim())) x.remove(); });
    const two = sh.querySelector(".two");
    const put = el => { if (two) two.before(el); else sh.appendChild(el); };
    // delivery and offers card
    const ret = p.ret > 0 ? p.ret + "-day returns" : p.ret === 0 ? "No returns on this product" : `Returns as per our <button class="lnk" data-pol="returns">Returns policy</button>`;
    put(mk(`<div class="box"><div class="pd-r"><em>🚚</em><div><b>${p.deliv ? "Delivery: " + safe(p.deliv) : "Delivery in 3 to 5 days"}</b><br><span class="muted">${p.p >= 499 ? "Free delivery" : "Delivery ₹40, free over ₹499"}</span></div></div><div class="pd-r"><em>💵</em><div><b>Cash on delivery</b><br><span class="muted">Pay when your order arrives</span></div></div><div class="pd-r"><em>↩️</em><div><b>${ret}</b></div></div><div class="pd-r"><em>🏷️</em><div><b>Extra 10% off with code VELOR10</b><br><span class="muted">Type the code in your cart</span></div></div></div>`));
    if (window.track) track("view_item", { currency: "INR", value: p.p, items: [{ item_id: String(p.id), item_name: p.n, price: p.p }] });
    if (WAN) put(mk(`<div class="box"><a class="big" data-wa="product" target="_blank" rel="noopener" href="${waLink('Hi VELOR4, I want to know more about "' + p.n + '" (' + inr(p.p) + "). " + plink(p.id))}" style="display:block;text-align:center;text-decoration:none;background:#25D366;color:#fff;box-shadow:none">Ask about this on WhatsApp</a></div>`));
    // product details card (description and specifications)
    const det = [...box.children].filter(x => x.tagName == "TABLE" || (x.tagName == "P" && x.style.whiteSpace == "pre-line"));
    if (det.length) { const c = mk(`<div class="box pd-d"><b class="pd-h">Product details</b></div>`); det.forEach(x => c.appendChild(x)); put(c); }
    // reviews card
    const rv = document.getElementById("rvbox"); if (rv) { rv.classList.add("box"); put(rv); }
    // similar products
    const sim = P.filter(x => x.c == p.c && x.id != p.id).slice(0, 8);
    if (sim.length) put(mk(`<div class="box"><b class="pd-h">Similar products</b><div class="dr" style="padding:0">${sim.map(x => `<button class="dc" data-v="${x.id}"><div class="dpic" style="background:${x.bg}">${x.e}</div><div class="sn">${safe(x.n)}</div><b>${inr(x.p)}</b><span>${disc(x)}% off</span></button>`).join("")}</div></div>`));
  };
  document.addEventListener("click", e => {
    const h = e.target.closest(".pg-h");
    if (h) h.setAttribute("aria-pressed", wish.includes(+h.dataset.w) ? "true" : "false");
  });
  // ---------- Product links and Share ----------
  const plink = id => location.origin + location.pathname + "?p=" + encodeURIComponent(id);
  window.copyLink = function (url, msg) {
    const done = () => toast(msg || "Link copied");
    const old = () => { const t = document.createElement("textarea"); t.value = url; t.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (_) { prompt("Copy this link:", url); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, old); else old();
  };
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-ps]"); if (!b) return;
    const p = find(b.dataset.ps); if (!p) return;
    const data = { title: "VELOR4", text: p.n + " – " + inr(p.p) + " on VELOR4", url: plink(p.id) };
    if (navigator.share) { try { await navigator.share(data); return; } catch (err) { if (err && err.name == "AbortError") return; } }
    viewShare(data);
  });
  // a link like ...?p=12 opens that product as soon as the products are loaded
  (() => {
    let id = null; try { id = new URLSearchParams(location.search).get("p"); } catch (_) {}
    if (!id) return;
    try { const u = new URLSearchParams(location.search); u.delete("p"); history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : "") + location.hash); } catch (_) {} // keep other parts of the link (like utm_source) for Analytics
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (loadState == "ready") { clearInterval(t); const p = find(id); if (p) viewProduct(p.id); else toast("This product is not available"); }
      else if (loadState == "error" || n > 60) clearInterval(t);
    }, 200);
  })();
  if (WAN) {
    const f = document.createElement("a");
    f.className = "wafab"; f.href = waLink("Hi VELOR4, I need help."); f.target = "_blank"; f.rel = "noopener"; f.setAttribute("data-wa", "home"); f.setAttribute("aria-label", "Ask on WhatsApp");
    f.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M9 8.2c.3 2.9 2.800 5.400 5.700 5.700l1.300-1.400-2-1-.9.8c-1.100-.5-2-1.400-2.500-2.500l.8-.9-1-2z" fill="#fff"/></svg>';
    document.body.appendChild(f);
  }
  document.addEventListener("click", e => { const w = e.target.closest("[data-wa]"); if (w && window.track) track("whatsapp_click", { place: w.dataset.wa }); });
  const mark = v => {
    const k = ["c", "o", "pay"].includes(v) ? "ct" : ["a", "l", "l2", "or", "t", "dela", "pw"].includes(v) ? "ac" : v == "w" ? "wl" : v == "cats" ? "cats" : "home";
    nav.querySelectorAll("button").forEach(x => x.setAttribute("aria-current", x.dataset.bn == k ? "true" : "false"));
  };
  const _o2 = open, _c2 = close;
  open = function (h, v) { _o2(h, v); mark(v); };
  close = function () { _c2(); mark(""); };
  mark("");
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-bn]"); if (!b) return;
    const k = b.dataset.bn;
    if (k == "home") window.scrollTo({ top: 0, behavior: "smooth" });
    else if (k == "cats") viewCats();
    else if (k == "cats-old") open(head("Categories") + `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${CATS.map(([c, e]) => `<button class="tile" data-c="${c}" data-close><span>${e}</span>${c}</button>`).join("")}</div>`, "cats");
    else { const t = document.getElementById(k); if (t) t.click(); }
  });
})();

// ---------- Voice search (mic in the search bar) ----------
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const q = document.getElementById("q");
  if (!SR || !q || !q.parentElement) return; // browsers without voice support simply do not show the mic
  const st = document.createElement("style");
  st.textContent = `#q{padding:13px 58px 13px 44px}
.sg{position:absolute;left:14px;top:22px;color:#6B7A99;pointer-events:none;display:grid}
.sg svg{width:20px;height:20px}
.mic{position:absolute;right:6px;top:16px;width:38px;height:38px;border:0;border-radius:50%;background:#E6EEFD;color:#1546B0;display:grid;place-items:center;padding:0;transition:background .15s}
.mic svg{width:20px;height:20px}
.mic.on{background:#E5484D;color:#fff;animation:micp 1.1s infinite}
@keyframes micp{0%{box-shadow:0 0 0 0 rgba(229,72,77,.5)}100%{box-shadow:0 0 0 14px rgba(229,72,77,0)}}
@media(prefers-reduced-motion:reduce){.mic.on{animation:none}}`;
  document.head.appendChild(st);
  const w = document.createElement("div");
  w.style.cssText = "position:relative;display:flow-root";
  q.before(w); w.appendChild(q);
  const b = document.createElement("button");
  b.type = "button"; b.className = "mic"; b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></svg>'; b.setAttribute("aria-label", "Search by voice");
  const g = document.createElement("span"); g.className = "sg"; g.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'; w.appendChild(g);
  w.appendChild(b);
  b.addEventListener("click", () => {
    const r = new SR();
    r.lang = "en-IN"; r.interimResults = false; r.maxAlternatives = 1;
    b.classList.add("on"); toast("Listening… say what you want");
    r.onresult = e => {
      q.value = e.results[0][0].transcript.replace(/[.,!?]+$/, "");
      q.dispatchEvent(new Event("input", { bubbles: true }));
    };
    r.onerror = e => toast(e.error === "not-allowed" ? "Please allow the microphone to use voice search" : "Could not hear you, try again");
    r.onend = () => b.classList.remove("on");
    try { r.start(); } catch (_) { b.classList.remove("on"); }
  });
})();

// ---------- Retry button for product loading ----------
document.addEventListener("click", e => {
  if (e.target.closest("[data-retry]")) { if (window.__retryLoad) window.__retryLoad(); else location.reload(); }
});

// ---------- Flipkart-style pages: product → cart → address → payment → success ----------
(() => {
  const sh = document.getElementById("sheet"); if (!sh) return;
  const PAGES = ["p", "c", "o", "pay", "d", "t", "or", "a", "w", "cats", "l", "l2", "dela", "pw"];
  const css = document.createElement("style");
  css.textContent = `
#sheet.page{inset:0!important;width:100%!important;max-height:none!important;border-radius:0!important;z-index:25;padding-top:calc(14px + env(safe-area-inset-top,0px))}
#sheet.page .top{position:sticky;top:calc(-14px - env(safe-area-inset-top,0px));margin:calc(-14px - env(safe-area-inset-top,0px)) -14px 10px;padding:calc(14px + env(safe-area-inset-top,0px)) 14px 8px;background:var(--bg);z-index:2}
#sheet.page .two{position:sticky;bottom:0;background:var(--bg);padding:10px 0 calc(4px + env(safe-area-inset-bottom,0px));margin-top:auto}
#sheet.page>.big{position:sticky;bottom:0;margin-top:auto;box-shadow:0 -8px 12px var(--bg)}
.steps{display:flex;align-items:center;gap:8px;font-size:.8rem;color:var(--muted);margin:0 0 12px;flex-wrap:wrap}
.steps span.on{color:var(--brand);font-weight:800}.steps span.done{color:var(--ok);font-weight:700}.steps i{font-style:normal}`;
  document.head.appendChild(css);
  // Android back button closes the page instead of leaving the site
  let pushed = false, ignore = 0, wantPush = false;
  const doPush = () => { try { history.pushState({ vp: 1 }, ""); pushed = true; } catch (e) {} };
  const _open = open, _close = close;
  open = function (h, v) {
    _open(h, v);
    const isPage = PAGES.includes(v);
    sh.classList.toggle("page", isPage);
    if (isPage && !pushed) { if (ignore > 0) wantPush = true; else doPush(); }
    sh.scrollTop = 0;
  };
  close = function () {
    _close(); sh.classList.remove("page");
    if (pushed) { pushed = false; ignore++; try { history.back(); } catch (e) { ignore--; } }
  };
  window.addEventListener("popstate", () => {
    if (ignore > 0) { ignore--; if (ignore == 0 && wantPush) { wantPush = false; doPush(); } return; }
    if (pushed) { pushed = false; _close(); sh.classList.remove("page"); }
  });

  const steps = n => `<div class="steps">${["Cart", "Address", "Payment"].map((t, i) => `<span class="${i + 1 == n ? "on" : i + 1 < n ? "done" : ""}">${i + 1 < n ? "✓" : i + 1} ${t}</span>`).join("<i>›</i>")}</div>`;
  const backBtn = (k, t) => `<p><button class="lnk" data-bk="${k}">‹ ${t}</button></p>`;
  const ld = () => { try { return JSON.parse(localStorage.getItem("velor4-addr")) || {}; } catch (e) { return {}; } };
  window.__ADDR = ld();

  const _vc = viewCart;
  viewCart = function () {
    _vc();
    const top = sh.querySelector(".top");
    if (top && Object.keys(cart).length) top.insertAdjacentHTML("afterend", steps(1));
  };
  viewCheckout = function () {
    if (window.track) track("begin_checkout");
    if (!Object.keys(cart).length) { viewCart(); return; }
    const A = window.__ADDR || {};
    const f = (lab, id, v, x) => `<label class="l" for="${id}">${lab}</label><input class="f" id="${id}" value="${safe(v || "")}" ${x || ""}>`;
    open(head("Delivery address") + steps(2) + backBtn("cart", "Back to cart") + `<div class="box">${f("Full name", "nm", A.nm || (user && user.nm), 'autocomplete="name"')}${f("Mobile number", "ph", A.ph || (user && user.ph), 'inputmode="numeric" maxlength="10" autocomplete="tel-national"')}${f("House no., street, area, city", "ad", A.ad, 'autocomplete="street-address"')}${f("PIN code", "pn", A.pn, 'inputmode="numeric" maxlength="6" autocomplete="postal-code"')}</div><div class="err" id="err" role="alert"></div><button class="big" data-addr>Deliver to this address</button>`, "o");
  };
  function viewPayment() {
    if (!Object.keys(cart).length) { viewCart(); return; }
    const A = window.__ADDR || {}, b = bill();
    open(head("Payment") + steps(3) + backBtn("addr", "Back to address") +
      `<div class="box"><b>Deliver to</b><br>${safe(A.nm)} · ${safe(A.ph)}<br><span class="muted">${safe(A.ad)} – ${safe(A.pn)}</span><br><button class="lnk" data-bk="addr">Change address</button></div>
      <div class="box"><b>Your items</b>${lines().map(({ p, sz, q }) => `<div class="row"><span>${safe(p.n)}${sz ? " (" + sz + ")" : ""} × ${q}</span><span>${inr(p.p * q)}</span></div>`).join("")}</div>
      <div class="box"><b>Price details</b><div class="row"><span>Item total</span><span>${inr(b.sub)}</span></div>${b.cp ? `<div class="row"><span>Coupon</span><span class="green">− ${inr(b.cp)}</span></div>` : ""}<div class="row"><span>Delivery</span><span class="${b.fee ? "" : "green"}">${b.fee ? inr(b.fee) : "Free"}</span></div><div class="row t2"><span>To pay</span><span>${inr(b.total)}</span></div></div>
      <div class="box"><b>Payment method</b><label class="pay"><input type="radio" name="py" value="Cash on delivery" checked> Cash on delivery (pay when the order arrives)</label></div>
      <div class="err" id="err" role="alert"></div><button class="big" data-pay>Place order · ${inr(b.total)}</button>`, "pay");
  }
  document.addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return; const d = t.dataset;
    if (d.addr !== undefined) {
      const g = id => document.getElementById(id).value.trim(), A = { nm: g("nm"), ph: g("ph"), ad: g("ad"), pn: g("pn") };
      if (A.nm.length < 2) { $("#err").textContent = "Enter your full name."; return; }
      if (!/^[6-9]\d{9}$/.test(A.ph)) { $("#err").textContent = "Enter a valid 10-digit mobile number."; return; }
      if (A.ad.length < 6) { $("#err").textContent = "Enter your full address (house, street, area, city)."; return; }
      if (!/^\d{6}$/.test(A.pn)) { $("#err").textContent = "Enter a valid 6-digit PIN code."; return; }
      window.__ADDR = A; try { localStorage.setItem("velor4-addr", JSON.stringify(A)); } catch (_) {}
      viewPayment();
    } else if (d.bk == "cart") viewCart();
    else if (d.bk == "addr") viewCheckout();
  });
})();

// light protection: no right-click / long-press menu or dragging on pictures
document.addEventListener("contextmenu", e => { if (e.target.tagName == "IMG") e.preventDefault(); });
document.addEventListener("dragstart", e => { if (e.target.tagName == "IMG") e.preventDefault(); });
(() => { const nd = document.createElement("style"); nd.textContent = "img{-webkit-user-drag:none;-webkit-touch-callout:none}"; document.head.appendChild(nd); })();

// the new design is in place: show the page (until now the screen stays plain blue, so the old layout never flashes)
document.documentElement.classList.remove("pre");
