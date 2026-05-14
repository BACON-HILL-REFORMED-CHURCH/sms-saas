export type Lang = 'en' | 'ar' | 'fr' | 'id';
export const SUPPORTED_LANGS: Lang[] = ['en', 'ar', 'fr', 'id'];

const translations: Record<Lang, Record<string, string>> = {
  en: {
    // ── Language selection ──
    select_language: '🌐 *Choose your language:*',

    // ── Welcome ──
    welcome:
      '🎉 *Welcome to SMS Shop!*\n\n' +
      '📲 Buy virtual phone numbers to verify any app.\n' +
      '📡 eSIM data plans for travelers.\n' +
      '⚡ Instant delivery at the best prices.',
    welcome_back:
      '👋 Welcome back, *{email}*!\n\nUse the menu below or open your dashboard.',
    open_dashboard: 'Open the full app:',

    // ── Auth ──
    btn_login:    '🔑 Login',
    btn_register: '✨ Create Account',
    enter_email:       '📧 Enter your email:',
    enter_password:    '🔒 Enter password:',
    choose_password:   '🔒 Choose a password (min 8 chars):',
    login_success:     '✅ *Welcome back, {email}!*',
    register_success:  '✅ *Account Created!*\n\nVerify your email, then /start to login.',
    login_error:       '❌ {msg}\n\nTry again: /start',
    register_error:    '❌ {msg}\n\nTry again: /start',

    // ── Keyboard button labels ──
    btn_balance:  '💰 Balance',
    btn_deposit:  '💳 Deposit',
    btn_buy:      '📱 Buy Number',
    btn_esim:     '📡 eSIM',
    btn_orders:   '📋 My Orders',
    btn_coupon:   '🎟️ Redeem Coupon',
    btn_referral: '👥 Referral',
    btn_admin:    '⚙️ Admin Panel',
    btn_logout:   '🚪 Logout',
    btn_cancel:   '❌ Cancel',

    // ── Balance ──
    balance_display: '💰 *Your Balance*\n\n*{balance}* credits\n≈ ${usd} USD',

    // ── Deposit / Recharge ──
    deposit_crypto:
      '💳 *Deposit Credits*\n\n' +
      '💱 Pay with crypto (Bitcoin, USDT, ETH and more)\n' +
      '📊 Rate: $1 = {rate} credits\n\n' +
      'Choose deposit amount:',
    recharge_select_method:
      '💳 *Recharge Request*\n\nSelect your payment method:',
    payment_details_binance: '💛 *Send payment to this Binance ID:*\n\n`{id}`\n\n📌 After sending, enter the amount in USD you sent (e.g. 10):',
    payment_details_usdt:    '💚 *Send USDT (TRC20) to this address:*\n\n`{address}`\n\n📌 After sending, enter the amount in USD you sent (e.g. 10):',
    payment_details_iban:    '🏦 *Transfer to this IBAN:*\n\n`{iban}`\n\n📌 After sending, enter the amount in USD you sent (e.g. 10):',
    payment_details_cih:     '🏧 *Transfer to this CIH Bank account:*\n\n`{account}`\n\n📌 After sending, enter the amount in USD you sent (e.g. 10):',
    payment_details_missing: '⚠️ Payment details not configured. Contact admin.',
    recharge_method_chosen: '✅ Method: *{method}*\n\nEnter the amount in USD (e.g. 10):',
    recharge_amount_chosen: '✅ Amount: *${amount}*\n\nEnter your transaction ID or reference number:',
    recharge_submitted:
      '✅ *Recharge Request Submitted!*\n\n' +
      'Method: {method}\n' +
      'Amount: *${amount}*\n' +
      'TxID: `{txid}`\n' +
      'Status: *PENDING* ⏳\n\n' +
      'Our team will review and approve within 24h.',
    recharge_invalid_amount: '❌ Please enter a valid amount (minimum $1):',
    recharge_select_prompt: 'Please select a method from the keyboard:',

    // ── Orders ──
    no_orders:      '📋 No orders yet.\n\nTap *📱 Buy Number* to get started!',
    waiting_sms:    '⏳ Waiting for SMS...',

    // ── Coupon ──
    coupon_prompt: '🎟️ *Redeem Coupon*\n\nEnter your coupon code:',

    // ── Referral ──
    referral_msg:
      '👥 *Referral Program*\n\n' +
      'Invite friends & earn *{bonus} credits* each!\n\n' +
      '🔗 Your link:\n`{link}`',

    // ── Logout ──
    logged_out:   '👋 Logged out. See you soon!',
    cancelled:    '❌ Cancelled.',

    // ── Errors ──
    unauthorized: '❌ Please login first: /start',

    // ── Help ──
    help_text:
      '📖 *SMS Shop — Help*\n\n' +
      '*How to buy a number:*\n' +
      '1. Tap 📱 Buy Number\n' +
      '2. Select country\n' +
      '3. Select service (WhatsApp, Telegram...)\n' +
      '4. Confirm purchase\n' +
      '5. Get your number + wait for SMS automatically! 🔔\n\n' +
      '*Credits:* 100 credits = $1.00\n' +
      '*Referral:* Earn {bonus} credits per friend\n\n' +
      '_Contact admin to top up your balance._',
  },

  ar: {
    select_language: '🌐 *اختر لغتك:*',

    welcome:
      '🎉 *مرحبًا بك في SMS Shop!*\n\n' +
      '📲 اشترِ أرقام هواتف افتراضية للتحقق من أي تطبيق.\n' +
      '📡 باقات بيانات eSIM للمسافرين.\n' +
      '⚡ توصيل فوري بأفضل الأسعار.',
    welcome_back: '👋 مرحبًا بعودتك، *{email}*!\n\nاستخدم القائمة أدناه أو افتح لوحة التحكم.',
    open_dashboard: 'افتح التطبيق الكامل:',

    btn_login:    '🔑 تسجيل الدخول',
    btn_register: '✨ إنشاء حساب',
    enter_email:      '📧 أدخل بريدك الإلكتروني:',
    enter_password:   '🔒 أدخل كلمة المرور:',
    choose_password:  '🔒 اختر كلمة مرور (8 أحرف على الأقل):',
    login_success:    '✅ *مرحبًا بعودتك، {email}!*',
    register_success: '✅ *تم إنشاء الحساب!*\n\nتحقق من بريدك الإلكتروني، ثم /start لتسجيل الدخول.',
    login_error:      '❌ {msg}\n\nحاول مرة أخرى: /start',
    register_error:   '❌ {msg}\n\nحاول مرة أخرى: /start',

    btn_balance:  '💰 الرصيد',
    btn_deposit:  '💳 إيداع',
    btn_buy:      '📱 شراء رقم',
    btn_esim:     '📡 eSIM',
    btn_orders:   '📋 طلباتي',
    btn_coupon:   '🎟️ كوبون',
    btn_referral: '👥 الإحالة',
    btn_admin:    '⚙️ لوحة الإدارة',
    btn_logout:   '🚪 تسجيل الخروج',
    btn_cancel:   '❌ إلغاء',

    balance_display: '💰 *رصيدك*\n\n*{balance}* كريديت\n≈ ${usd} دولار',

    deposit_crypto:
      '💳 *إيداع كريديتات*\n\n' +
      '💱 الدفع بالعملات المشفرة (Bitcoin، USDT، ETH والمزيد)\n' +
      '📊 السعر: $1 = {rate} كريديت\n\n' +
      'اختر مبلغ الإيداع:',
    recharge_select_method: '💳 *طلب شحن*\n\nاختر طريقة الدفع:',
    payment_details_binance: '💛 *أرسل الدفعة إلى Binance ID هذا:*\n\n`{id}`\n\n📌 بعد الإرسال، أدخل المبلغ بالدولار (مثال: 10):',
    payment_details_usdt:    '💚 *أرسل USDT (TRC20) إلى هذا العنوان:*\n\n`{address}`\n\n📌 بعد الإرسال، أدخل المبلغ بالدولار (مثال: 10):',
    payment_details_iban:    '🏦 *حوّل إلى هذا الـ IBAN:*\n\n`{iban}`\n\n📌 بعد التحويل، أدخل المبلغ بالدولار (مثال: 10):',
    payment_details_cih:     '🏧 *حوّل إلى حساب CIH Bank هذا:*\n\n`{account}`\n\n📌 بعد التحويل، أدخل المبلغ بالدولار (مثال: 10):',
    payment_details_missing: '⚠️ تفاصيل الدفع غير مكوّنة. تواصل مع الإدارة.',
    recharge_method_chosen: '✅ الطريقة: *{method}*\n\nأدخل المبلغ بالدولار (مثال: 10):',
    recharge_amount_chosen: '✅ المبلغ: *${amount}*\n\nأدخل رقم المعاملة أو المرجع:',
    recharge_submitted:
      '✅ *تم تقديم طلب الشحن!*\n\n' +
      'الطريقة: {method}\n' +
      'المبلغ: *${amount}*\n' +
      'رقم المعاملة: `{txid}`\n' +
      'الحالة: *قيد الانتظار* ⏳\n\n' +
      'سيراجع فريقنا طلبك ويوافق عليه خلال 24 ساعة.',
    recharge_invalid_amount: '❌ أدخل مبلغًا صحيحًا (الحد الأدنى $1):',
    recharge_select_prompt: 'يرجى اختيار طريقة من لوحة المفاتيح:',

    no_orders:   '📋 لا توجد طلبات بعد.\n\nاضغط *📱 شراء رقم* للبدء!',
    waiting_sms: '⏳ في انتظار الرسالة...',

    coupon_prompt: '🎟️ *استرداد كوبون*\n\nأدخل رمز الكوبون:',

    referral_msg:
      '👥 *برنامج الإحالة*\n\n' +
      'ادعُ أصدقاءك واكسب *{bonus} كريديت* لكل واحد!\n\n' +
      '🔗 رابطك:\n`{link}`',

    logged_out: '👋 تم تسجيل الخروج. إلى اللقاء!',
    cancelled:  '❌ تم الإلغاء.',

    unauthorized: '❌ يرجى تسجيل الدخول أولاً: /start',

    help_text:
      '📖 *SMS Shop — المساعدة*\n\n' +
      '*كيفية شراء رقم:*\n' +
      '1. اضغط 📱 شراء رقم\n' +
      '2. اختر الدولة\n' +
      '3. اختر الخدمة (WhatsApp، Telegram...)\n' +
      '4. تأكيد الشراء\n' +
      '5. احصل على رقمك وانتظر الرسالة تلقائيًا! 🔔\n\n' +
      '*الكريديتات:* 100 كريديت = $1.00\n' +
      '*الإحالة:* اكسب {bonus} كريديت لكل صديق\n\n' +
      '_تواصل مع الإدارة لشحن رصيدك._',
  },

  fr: {
    select_language: '🌐 *Choisissez votre langue:*',

    welcome:
      '🎉 *Bienvenue sur SMS Shop!*\n\n' +
      '📲 Achetez des numéros virtuels pour vérifier n\'importe quelle app.\n' +
      '📡 Forfaits eSIM pour voyageurs.\n' +
      '⚡ Livraison instantanée aux meilleurs prix.',
    welcome_back: '👋 Bon retour, *{email}*!\n\nUtilisez le menu ci-dessous ou ouvrez votre tableau de bord.',
    open_dashboard: 'Ouvrir l\'application:',

    btn_login:    '🔑 Connexion',
    btn_register: '✨ Créer un compte',
    enter_email:      '📧 Entrez votre email:',
    enter_password:   '🔒 Entrez le mot de passe:',
    choose_password:  '🔒 Choisissez un mot de passe (min 8 caractères):',
    login_success:    '✅ *Bon retour, {email}!*',
    register_success: '✅ *Compte créé!*\n\nVérifiez votre email, puis /start pour vous connecter.',
    login_error:      '❌ {msg}\n\nRéessayez: /start',
    register_error:   '❌ {msg}\n\nRéessayez: /start',

    btn_balance:  '💰 Solde',
    btn_deposit:  '💳 Dépôt',
    btn_buy:      '📱 Acheter Numéro',
    btn_esim:     '📡 eSIM',
    btn_orders:   '📋 Mes Commandes',
    btn_coupon:   '🎟️ Coupon',
    btn_referral: '👥 Parrainage',
    btn_admin:    '⚙️ Admin Panel',
    btn_logout:   '🚪 Déconnexion',
    btn_cancel:   '❌ Annuler',

    balance_display: '💰 *Votre Solde*\n\n*{balance}* crédits\n≈ ${usd} USD',

    deposit_crypto:
      '💳 *Déposer des Crédits*\n\n' +
      '💱 Payez en crypto (Bitcoin, USDT, ETH et plus)\n' +
      '📊 Taux: $1 = {rate} crédits\n\n' +
      'Choisissez le montant:',
    recharge_select_method: '💳 *Demande de Recharge*\n\nChoisissez votre méthode de paiement:',
    payment_details_binance: '💛 *Envoyez le paiement à ce Binance ID:*\n\n`{id}`\n\n📌 Après envoi, entrez le montant en USD (ex: 10):',
    payment_details_usdt:    '💚 *Envoyez USDT (TRC20) à cette adresse:*\n\n`{address}`\n\n📌 Après envoi, entrez le montant en USD (ex: 10):',
    payment_details_iban:    '🏦 *Transférez à cet IBAN:*\n\n`{iban}`\n\n📌 Après envoi, entrez le montant en USD (ex: 10):',
    payment_details_cih:     '🏧 *Transférez à ce compte CIH Bank:*\n\n`{account}`\n\n📌 Après envoi, entrez le montant en USD (ex: 10):',
    payment_details_missing: '⚠️ Coordonnées de paiement non configurées. Contactez l\'admin.',
    recharge_method_chosen: '✅ Méthode: *{method}*\n\nEntrez le montant en USD (ex: 10):',
    recharge_amount_chosen: '✅ Montant: *${amount}*\n\nEntrez votre ID de transaction ou référence:',
    recharge_submitted:
      '✅ *Demande de Recharge Soumise!*\n\n' +
      'Méthode: {method}\n' +
      'Montant: *${amount}*\n' +
      'TxID: `{txid}`\n' +
      'Statut: *EN ATTENTE* ⏳\n\n' +
      'Notre équipe examinera et approuvera dans les 24h.',
    recharge_invalid_amount: '❌ Entrez un montant valide (minimum $1):',
    recharge_select_prompt: 'Veuillez sélectionner une méthode sur le clavier:',

    no_orders:   '📋 Aucune commande.\n\nAppuyez sur *📱 Acheter Numéro* pour commencer!',
    waiting_sms: '⏳ En attente du SMS...',

    coupon_prompt: '🎟️ *Utiliser un Coupon*\n\nEntrez votre code coupon:',

    referral_msg:
      '👥 *Programme de Parrainage*\n\n' +
      'Invitez des amis et gagnez *{bonus} crédits* chacun!\n\n' +
      '🔗 Votre lien:\n`{link}`',

    logged_out: '👋 Déconnecté. À bientôt!',
    cancelled:  '❌ Annulé.',

    unauthorized: '❌ Veuillez vous connecter d\'abord: /start',

    help_text:
      '📖 *SMS Shop — Aide*\n\n' +
      '*Comment acheter un numéro:*\n' +
      '1. Appuyez sur 📱 Acheter Numéro\n' +
      '2. Sélectionnez le pays\n' +
      '3. Sélectionnez le service (WhatsApp, Telegram...)\n' +
      '4. Confirmez l\'achat\n' +
      '5. Obtenez votre numéro + attendez le SMS automatiquement! 🔔\n\n' +
      '*Crédits:* 100 crédits = $1.00\n' +
      '*Parrainage:* Gagnez {bonus} crédits par ami\n\n' +
      '_Contactez l\'admin pour recharger votre solde._',
  },

  id: {
    select_language: '🌐 *Pilih bahasa Anda:*',

    welcome:
      '🎉 *Selamat datang di SMS Shop!*\n\n' +
      '📲 Beli nomor telepon virtual untuk verifikasi aplikasi apa pun.\n' +
      '📡 Paket data eSIM untuk wisatawan.\n' +
      '⚡ Pengiriman instan dengan harga terbaik.',
    welcome_back: '👋 Selamat datang kembali, *{email}*!\n\nGunakan menu di bawah atau buka dashboard Anda.',
    open_dashboard: 'Buka aplikasi lengkap:',

    btn_login:    '🔑 Masuk',
    btn_register: '✨ Buat Akun',
    enter_email:      '📧 Masukkan email Anda:',
    enter_password:   '🔒 Masukkan kata sandi:',
    choose_password:  '🔒 Pilih kata sandi (min 8 karakter):',
    login_success:    '✅ *Selamat datang kembali, {email}!*',
    register_success: '✅ *Akun Dibuat!*\n\nVerifikasi email Anda, lalu /start untuk masuk.',
    login_error:      '❌ {msg}\n\nCoba lagi: /start',
    register_error:   '❌ {msg}\n\nCoba lagi: /start',

    btn_balance:  '💰 Saldo',
    btn_deposit:  '💳 Deposit',
    btn_buy:      '📱 Beli Nomor',
    btn_esim:     '📡 eSIM',
    btn_orders:   '📋 Pesanan Saya',
    btn_coupon:   '🎟️ Kupon',
    btn_referral: '👥 Referral',
    btn_admin:    '⚙️ Admin Panel',
    btn_logout:   '🚪 Keluar',
    btn_cancel:   '❌ Batal',

    balance_display: '💰 *Saldo Anda*\n\n*{balance}* kredit\n≈ ${usd} USD',

    deposit_crypto:
      '💳 *Deposit Kredit*\n\n' +
      '💱 Bayar dengan kripto (Bitcoin, USDT, ETH dan lainnya)\n' +
      '📊 Kurs: $1 = {rate} kredit\n\n' +
      'Pilih jumlah deposit:',
    recharge_select_method: '💳 *Permintaan Isi Ulang*\n\nPilih metode pembayaran:',
    payment_details_binance: '💛 *Kirim pembayaran ke Binance ID ini:*\n\n`{id}`\n\n📌 Setelah mengirim, masukkan jumlah USD yang dikirim (contoh: 10):',
    payment_details_usdt:    '💚 *Kirim USDT (TRC20) ke alamat ini:*\n\n`{address}`\n\n📌 Setelah mengirim, masukkan jumlah USD yang dikirim (contoh: 10):',
    payment_details_iban:    '🏦 *Transfer ke IBAN ini:*\n\n`{iban}`\n\n📌 Setelah mengirim, masukkan jumlah USD yang dikirim (contoh: 10):',
    payment_details_cih:     '🏧 *Transfer ke rekening CIH Bank ini:*\n\n`{account}`\n\n📌 Setelah mengirim, masukkan jumlah USD yang dikirim (contoh: 10):',
    payment_details_missing: '⚠️ Detail pembayaran belum dikonfigurasi. Hubungi admin.',
    recharge_method_chosen: '✅ Metode: *{method}*\n\nMasukkan jumlah dalam USD (contoh: 10):',
    recharge_amount_chosen: '✅ Jumlah: *${amount}*\n\nMasukkan ID transaksi atau nomor referensi:',
    recharge_submitted:
      '✅ *Permintaan Isi Ulang Dikirim!*\n\n' +
      'Metode: {method}\n' +
      'Jumlah: *${amount}*\n' +
      'TxID: `{txid}`\n' +
      'Status: *MENUNGGU* ⏳\n\n' +
      'Tim kami akan meninjau dan menyetujui dalam 24 jam.',
    recharge_invalid_amount: '❌ Masukkan jumlah yang valid (minimal $1):',
    recharge_select_prompt: 'Silakan pilih metode dari keyboard:',

    no_orders:   '📋 Belum ada pesanan.\n\nKetuk *📱 Beli Nomor* untuk memulai!',
    waiting_sms: '⏳ Menunggu SMS...',

    coupon_prompt: '🎟️ *Tukarkan Kupon*\n\nMasukkan kode kupon Anda:',

    referral_msg:
      '👥 *Program Referral*\n\n' +
      'Ajak teman & dapatkan *{bonus} kredit* per orang!\n\n' +
      '🔗 Link Anda:\n`{link}`',

    logged_out: '👋 Keluar. Sampai jumpa!',
    cancelled:  '❌ Dibatalkan.',

    unauthorized: '❌ Silakan masuk terlebih dahulu: /start',

    help_text:
      '📖 *SMS Shop — Bantuan*\n\n' +
      '*Cara membeli nomor:*\n' +
      '1. Ketuk 📱 Beli Nomor\n' +
      '2. Pilih negara\n' +
      '3. Pilih layanan (WhatsApp, Telegram...)\n' +
      '4. Konfirmasi pembelian\n' +
      '5. Dapatkan nomor + tunggu SMS otomatis! 🔔\n\n' +
      '*Kredit:* 100 kredit = $1.00\n' +
      '*Referral:* Dapatkan {bonus} kredit per teman\n\n' +
      '_Hubungi admin untuk mengisi saldo Anda._',
  },
};

export function t(
  lang: string,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const strings = translations[lang as Lang] ?? translations.en;
  let str = strings[key] ?? translations.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return str;
}
