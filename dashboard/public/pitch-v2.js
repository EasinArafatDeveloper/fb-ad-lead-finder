(function () {
  var PERSONAS = [
    {
      id: 'web',
      title: '💻 Freelancer / Web Dev',
      sub: 'ওয়েব ডেভেলপার ও ডিজিটাল এজেন্সি',
      rule: 'Active Ads >= 3 AND Website = NULL AND Phone/WA Exists',
      count: 22642,
      pitch: 'আসসালামু আলাইকুম {page}! দেখলাম আপনারা ফেসবুকে নিয়মিত {ads}টি অ্যাড চালাচ্ছেন কিন্তু আপনাদের কোনো ওয়েবসাইট যুক্ত করা নেই। কাস্টমারদের অটোমেটিক অর্ডার নেওয়ার জন্য আমরা সাশ্রয়ী মূল্যে ই-কমার্স ওয়েবসাইট তৈরি করছি। একটি ডেমো দেখবেন কি?',
      leads: [
        { name: 'Royal Attire BD', cat: 'Clothing (Brand)', ads: '14 Active Ads', why: 'নিয়মিত অ্যাড চালায় কিন্তু কোনো Website নেই', phone: '+8801711-849201', email: 'royalattire.bd@gmail.com' },
        { name: 'Glow Skin Secret', cat: 'Beauty & Cosmetics', ads: '9 Active Ads', why: 'শুধু ইনবক্স ও হোয়াটসঅ্যাপে অর্ডার নেয়, সাইট নেই', phone: '+8801819-330412', email: 'sales.glowskin@gmail.com' },
        { name: 'Smart Gadget Zone', cat: 'Shopping & Retail', ads: '21 Active Ads', why: '২১টি রানিং অ্যাড চলছে, ল্যান্ডিং পেজ দরকার', phone: '+8801912-558190', email: 'gadgetzone.dhaka@gmail.com' },
        { name: 'Pure Honey & Nuts', cat: 'Organic Food', ads: '7 Active Ads', why: 'ওয়েবসাইট ছাড়া মেসেঞ্জারে অর্ডার নিচ্ছে', phone: '+8801674-901234', email: 'purehoneybd@yahoo.com' }
      ]
    },
    {
      id: 'video',
      title: '🎬 Video Editor / Ad Expert',
      sub: 'ভিডিও এডিটর, গ্রাফিক ও মিডিয়া বায়ার',
      rule: 'Ad Formats = Image Only (0 Video Ads) AND Active Seller',
      count: 18450,
      pitch: 'আসসালামু আলাইকুম {page}! আপনাদের প্রোডাক্টগুলো দারুণ, কিন্তু লক্ষ্য করলাম আপনারা শুধু ছবি (Image) দিয়ে অ্যাড চালাচ্ছেন। ভিডিও অ্যাড ব্যবহার করলে সেলস ২-৩ গুণ বাড়ে। আমি কি আপনাদের জন্য একটি ডেমো ভিডিও অ্যাড বানিয়ে দেখাব?',
      leads: [
        { name: 'Zara Modest Wear', cat: "Women's clothing store", ads: '6 Image Ads (0 Video)', why: 'একটিও ভিডিও অ্যাড নেই, শুধু স্টিল ছবি', phone: '+8801755-210983', email: 'zaramodest@gmail.com' },
        { name: 'Dhaka Leather Craft', cat: 'Product/service', ads: '5 Image Ads (0 Video)', why: 'প্রোডাক্ট ভালো কিন্তু ভিডিও রিভিউ অ্যাড নেই', phone: '+8801841-776520', email: 'dhakaleather@gmail.com' },
        { name: 'Aroma Perfume BD', cat: 'Beauty, cosmetic & care', ads: '8 Image Ads (0 Video)', why: 'প্রিমিয়াম প্রোডাক্ট, ভিডিও হুক প্রয়োজন', phone: '+8801977-402911', email: 'aromaperfume.bd@gmail.com' },
        { name: 'Kids Toy Planet', cat: 'Shopping & retail', ads: '4 Image Ads (0 Video)', why: 'খেলনার জন্য ভিডিও অ্যাড সবচেয়ে জরুরি', phone: '+8801611-883401', email: 'kidstoyplanet@gmail.com' }
      ]
    },
    {
      id: 'dealer',
      title: '📦 Wholesaler / Dealer',
      sub: 'পাইকারি বিক্রেতা, ফ্যাক্টরি ও ইমপোর্টার',
      rule: 'Verified F-Commerce Retailers by Product Category',
      count: 34120,
      pitch: 'আসসালামু আলাইকুম {page}! আপনারা নিয়মিত অনলাইনে প্রোডাক্ট সেল করছেন দেখে নক দিলাম। আমরা সরাসরি ফ্যাক্টরি ও ইমপোর্ট রেটে পাইকারি মাল সাপ্লাই দিই। আমাদের পাইকারি প্রাইস লিস্ট ও ক্যাটালগ হোয়াটসঅ্যাপে পাঠাব কি?',
      leads: [
        { name: 'Trendy Panjabi House', cat: 'Clothing (Brand)', ads: '18 Active Ads', why: 'প্রতিদিন খুচরা পোশাক বিক্রি করে (পাইকারি ক্রেতা)', phone: '+8801713-664209', email: 'trendypanjabi@gmail.com' },
        { name: 'Velvet Touch Hijab', cat: "Women's clothing store", ads: '12 Active Ads', why: 'নিয়মিত গার্মেন্টস ও কাপড়ের স্টক প্রয়োজন', phone: '+8801822-918374', email: 'velvettouch.bd@gmail.com' },
        { name: 'Seoul Korean Mart BD', cat: 'Beauty & Cosmetics', ads: '15 Active Ads', why: 'কসমেটিকস রিসেলার, ইমপোর্টারদের সরাসরি ক্লায়েন্ট', phone: '+8801933-109283', email: 'seoulmartbd@gmail.com' },
        { name: 'Sundarban Organic Mart', cat: 'Organic Food', ads: '11 Active Ads', why: 'পাইকারি মধু, ঘি ও অর্গানিক পণ্যের নিয়মিত ক্রেতা', phone: '+8801799-302918', email: 'sundarbanghee@gmail.com' }
      ]
    },
    {
      id: 'supplier',
      title: '🏷️ Packaging / Small Supplier',
      sub: 'কার্টন বক্স, পলিব্যাগ, প্রিন্টিং, কুরিয়ার ও সফটওয়্যার',
      rule: 'Running Days >= 90 AND Active Ads >= 5 (High Daily Parcels)',
      count: 14890,
      pitch: 'আসসালামু আলাইকুম {page}! আপনারা দীর্ঘদিন ধরে নিয়মিত প্রচুর অর্ডার ডেলিভারি করছেন। আপনাদের ব্র্যান্ডের লোগোসহ কাস্টম কুরিয়ার বক্স, পলিব্যাগ ও স্টিকার আমরা সবচেয়ে কম রেটে তৈরি করি। স্যাম্পল ও প্রাইস লিস্ট দেখবেন কি?',
      leads: [
        { name: 'Urban Footwear BD', cat: 'Shopping & retail', ads: '26 Ads · 310 Days', why: 'প্রতিদিন ১০০+ পার্সেল যায় (জুতার বক্স ও পলি লাগে)', phone: '+8801711-009281', email: 'urbanfootwear.bd@gmail.com' },
        { name: 'Sunnah Lifestyle', cat: 'Clothing (Brand)', ads: '19 Ads · 240 Days', why: '৮ মাস ধরে টানা অ্যাড চালাচ্ছে, প্রিন্টেড প্যাকেজিং দরকার', phone: '+8801817-554321', email: 'sunnahlifestyle@gmail.com' },
        { name: 'ElectroMart Official', cat: 'E-commerce website', ads: '32 Ads · WooCommerce', why: 'বড় ই-কমার্স স্টোর, কুরিয়ার ও POS সার্ভিস দরকার', phone: '+8801911-772615', email: 'info@electromartbd.com' },
        { name: 'Organic Herbs Care', cat: 'Health/beauty', ads: '14 Ads · 195 Days', why: 'বোতল, লেবেল ও বাবল র‍্যাপের নিয়মিত ক্রেতা', phone: '+8801688-443210', email: 'organicherbscare@gmail.com' }
      ]
    }
  ];

  var MULT = { all: 1, clothing: 0.28, beauty: 0.19, gadget: 0.16, health: 0.12 };
  var cur = PERSONAS[0];
  var unlocked = false;

  function maskPhone(p) { return p.slice(0, 9) + '***' + p.slice(-2); }
  function maskEmail(e) { var s = e.split('@'); return s[0].slice(0, 3) + '***@' + s[1]; }

  function renderPersonas() {
    var g = document.getElementById('personaGrid');
    g.innerHTML = PERSONAS.map(function (p) {
      return '<button data-id="' + p.id + '" class="persona-btn ' + (p.id === cur.id ? 'active' : '') + '">' +
        '<div class="persona-title">' + p.title + '</div>' +
        '<div class="persona-sub">' + p.sub + '</div>' +
      '</button>';
    }).join('');
    Array.prototype.forEach.call(g.querySelectorAll('button'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        cur = PERSONAS.find(function (x) { return x.id === id; }) || PERSONAS[0];
        renderPersonas();
        renderTable();
      });
    });
  }

  function renderTable() {
    var cat = document.getElementById('catSelect').value;
    var n = Math.round(cur.count * (MULT[cat] || 1));
    document.getElementById('ruleBox').textContent = cur.rule;
    document.getElementById('matchCount').textContent = n.toLocaleString('en-US') + ' Leads';
    var mode = document.getElementById('modeLabel');
    mode.textContent = unlocked ? 'Unlocked Mode (Full Contacts Visible)' : 'Preview Mode (Numbers Masked)';
    mode.style.color = unlocked ? '#10b981' : '#f59e0b';

    var tbody = document.getElementById('leadRows');
    tbody.innerHTML = cur.leads.map(function (l, idx) {
      return '<tr>' +
        '<td style="font-weight:700; color:#fff;">' + l.name + '</td>' +
        '<td style="color:#94a3b8;">' + l.cat + '</td>' +
        '<td><span class="pill">' + l.ads + '</span></td>' +
        '<td style="color:#cbd5e1;">' + l.why + '</td>' +
        '<td style="font-family:monospace; color:' + (unlocked ? '#10b981' : '#94a3b8') + '; font-weight:' + (unlocked ? '700' : '400') + ';">' + (unlocked ? l.phone : maskPhone(l.phone)) + '</td>' +
        '<td style="font-family:monospace; color:' + (unlocked ? '#fff' : '#94a3b8') + ';">' + (unlocked ? l.email : maskEmail(l.email)) + '</td>' +
        '<td><button data-idx="' + idx + '" class="btn-primary" style="padding:6px 10px; font-size:11px;">💬 Pitch</button></td>' +
      '</tr>';
    }).join('');

    Array.prototype.forEach.call(tbody.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        var item = cur.leads[Number(b.getAttribute('data-idx'))];
        updatePitch(item);
      });
    });
    updatePitch(cur.leads[0]);
  }

  function updatePitch(item) {
    var adsNum = item.ads.split(' ')[0];
    document.getElementById('pitchText').textContent = '"' + cur.pitch.replace('{page}', item.name).replace('{ads}', adsNum) + '"';
  }

  document.getElementById('catSelect').addEventListener('change', renderTable);
  document.getElementById('unlockBtn').addEventListener('click', function () {
    unlocked = !unlocked;
    this.textContent = unlocked ? '🔒 Switch to Masked Preview' : '🔓 Simulate "Unlock Leads after Payment"';
    renderTable();
  });

  document.getElementById('buyerRange').addEventListener('input', function () {
    var v = Number(this.value);
    document.getElementById('buyerLabel').textContent = v + ' Buyers / month';
    document.getElementById('revLabel').textContent = '৳' + (v * 1200).toLocaleString('en-IN') + ' / mo';
  });

  renderPersonas();
  renderTable();
})();
