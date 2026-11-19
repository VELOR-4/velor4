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
      e: main ? `<img src="${safe(main)}" alt="">` : "📦", bg: "#ECE6FB", r: 0, rv: "0",
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
    $("#apitems").innerHTML = l.length ? l.map(p => { const s = stockOf(p); return `<div class="box"><div class="line" style="border:0;padding:0"><div class="t" style="background:#ECE6FB">${p.image_url ? `<img src="${safe(p.image_url)}" alt="">` : "📦"}</div><div class="n"><b>${safe(p.name)}</b>${p.featured ? " ⭐" : ""}<br><span class="muted">${safe(p.sku || "")} · ${safe(p.category)}</span><br>${inr(p.price)} · Stock: ${s == null ? "—" : s} · <b>${STL[p.status] || p.status}</b><br><span class="muted">${ratingText(p.id)}</span></div></div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="sz" data-pe="${p.id}">Edit</button><button class="sz" data-pd="${p.id}">Duplicate</button><button class="sz" data-pt="${p.id}">${p.status == "active" ? "Unpublish" : "Publish"}</button><button class="sz" data-px="${p.id}">Delete</button></div></div>`; }).join("") : `<div class="box">No products found.</div>`;
    const more = $("#apmore"); if (more) more.hidden = total <= AD.n;
  }
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
    cart = {}; coupon = ""; save(); render(); await loadOrders();
    open(head("Order placed") + `<div class="box" style="text-align:center"><div style="font-size:3rem">🎉</div><b>Order ${res.order_no} confirmed</b><p>Delivery by <b>${d}</b></p><p class="muted">${inr(res.total)} via ${py}<br>Shipping to ${safe(nm)}, ${safe(ad)} – ${pn}</p></div><button class="big" data-track="${res.order_no}">Track order</button><br><br><button class="sz" data-close style="width:100%;border-radius:12px;padding:12px">Continue shopping</button>`, "d");
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
  // Slides come from ads.json (easy to edit on GitHub). If it is missing or broken, the list above is used.
  const okUrl = u => typeof u === "string" && (/^(https?:|mailto:|tel:)/i.test(u) || /^[\w./-]+$/.test(u));
  const okBg = v => typeof v === "string" && /^[#a-z0-9(),.%\s-]+$/i.test(v);
  const drawPromo = L => L.slice(0, 10).map(b => {
    const bg = okBg(b.bg) ? b.bg : "linear-gradient(120deg,#4A1FC4,#7B4DF0)";
    const img = okUrl(b.img) ? String(b.img).replace(/['")\\]/g, "") : "";
    const st2 = `background:${img ? `linear-gradient(0deg,rgba(0,0,0,.35),rgba(0,0,0,.1)),url('${img}')` : bg};`;
    const inner = `${b.tag ? `<em>${safe(b.tag)}</em>` : ""}<b>${safe(b.t || "")}</b><span>${safe(b.s || "")}</span>`;
    return okUrl(b.link) ? `<a class="slide" href="${String(b.link).replace(/"/g, "")}" style="${st2}">${inner}</a>` : `<div class="slide" style="${st2}">${inner}</div>`;
  }).join("");
  promo.innerHTML = drawPromo(BANNERS);
  fetch("ads.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(L => { if (Array.isArray(L) && L.length) promo.innerHTML = drawPromo(L); }).catch(() => {});
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

// ---------- Voice search (mic in the search bar) ----------
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const q = document.getElementById("q");
  if (!SR || !q || !q.parentElement) return; // browsers without voice support simply do not show the mic
  const st = document.createElement("style");
  st.textContent = "#q{padding-right:54px}.mic{position:absolute;right:6px;top:10px;bottom:0;width:46px;border:0;background:none;font-size:1.3rem;color:#5B2BD9;border-radius:12px}.mic.on{color:#D63A6A;animation:micp 1s infinite}@keyframes micp{50%{transform:scale(1.2)}}@media(prefers-reduced-motion:reduce){.mic.on{animation:none}}";
  document.head.appendChild(st);
  const w = document.createElement("div");
  w.style.cssText = "position:relative;display:flow-root";
  q.before(w); w.appendChild(q);
  const b = document.createElement("button");
  b.type = "button"; b.className = "mic"; b.textContent = "🎤"; b.setAttribute("aria-label", "Search by voice");
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
  const PAGES = ["p", "c", "o", "pay", "d", "t", "or", "a", "w"];
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
