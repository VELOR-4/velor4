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
    user = { nm: (pr && pr.name) || (tmpU && tmpU.nm) || "Customer", ph: ((pr && pr.phone) || session.user.phone || "").slice(-10) };
    isAdmin = !!(pr && pr.is_admin); sv("velor4-user", user);
  }
  window.sbOut = async () => { await sb.auth.signOut(); isAdmin = false; orders = []; };

  sendOtp = async function () {
    const nm = $("#ln").value.trim(), ph = $("#lp").value.trim();
    if (!nm || !/^[6-9]\d{9}$/.test(ph)) { $("#err").textContent = "Enter your name and a valid 10-digit mobile number."; return; }
    const { error } = await sb.auth.signInWithOtp({ phone: "+91" + ph, options: { data: { name: nm } } });
    if (error) { $("#err").textContent = "Could not send OTP: " + (error.message || error.code || "unknown error"); return; }
    tmpU = { nm, ph };
    open(head("Verify OTP") + `<div class="box"><p>Enter the OTP sent to +91 ${ph}.</p><input class="f" id="ot" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="OTP"><div class="err" id="err" role="alert"></div></div><button class="big" data-ver>Verify and continue</button>`, "l2");
  };
  verify = async function () {
    const { error } = await sb.auth.verifyOtp({ phone: "+91" + tmpU.ph, token: $("#ot").value.trim(), type: "sms" });
    if (error) { $("#err").textContent = "OTP problem: " + (error.message || "unknown error"); return; }
    await restore(); await loadOrders(); toast("Logged in");
    after == "co" ? viewCheckout() : viewAccount();
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
    const { data, error } = await sb.functions.invoke("create-order", {
      body: { items: lines().map(({ p, sz, q }) => ({ id: p.id, sz, q })), coupon, method: py == "Cash on delivery" ? "cod" : "online", name: nm, phone: ph, address: ad, pincode: pn }
    });
    if (error || !data || data.error) { fail((data && data.error) || "Could not place the order. Please try again."); return; }
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
