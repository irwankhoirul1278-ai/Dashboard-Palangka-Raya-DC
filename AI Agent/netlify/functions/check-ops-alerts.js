/**
 * netlify/functions/check-ops-alerts.js
 * ------------------------------------------------------------------
 * Scheduled Function (jalan tiap 1 JAM, jadwal di netlify.toml).
 * Ngecek 2 kondisi operasional:
 *
 *   1. Late Arrival numpuk hari ini (Inbound) — alert SEKALI per hari,
 *      begitu jumlahnya nembus LATE_ARRIVAL_ALERT_THRESHOLD. Reset
 *      otomatis kalau angkanya turun lagi di bawah ambang batas
 *      (misal ada koreksi data). Karena file ini sekarang jalan tiap
 *      1 jam (bukan 15 menit lagi), deteksi Late Arrival paling
 *      lambat 1 jam ketinggalan dari kejadian aslinya.
 *   2. Operator istirahat >60 menit (Rest Time) — REMINDER ULANG
 *      tiap kali function ini jalan (tiap 1 jam) selama operatornya
 *      masih tercatat istirahat >60 menit. Gak ada dedup harian lagi
 *      di sini — frekuensi reminder-nya murni ngikutin jadwal cron
 *      di netlify.toml.
 *
 * State notifikasi Late Arrival disimpen di Firebase (bukan di memory
 * function, karena tiap invocation Netlify Function itu proses baru).
 */

const {
  db,
  getInboundTrips,
  getRestAssetData,
  computeRestAssetLiveStatus,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  todayStr,
} = require("./_seatalk-common");

// Sesuaikan sendiri angka ini kalau ambang batasnya kurang/kelebihan sensitif.
const LATE_ARRIVAL_ALERT_THRESHOLD = 5;

async function checkLateArrival(groupId, token) {
  const today = todayStr();
  const trips = await getInboundTrips();
  const lateToday = trips.filter((t) => {
    const d = t.tanggal || (t.stdOrigin ? String(t.stdOrigin).slice(0, 10) : null);
    return d === today && t.statusText === "Late Arrival";
  });

  const stateRef = db().ref("prDcInboundTracking/alertState/" + today);
  const stateSnap = await stateRef.get();
  const alreadyAlerted = !!(stateSnap.val() && stateSnap.val().lateArrivalAlerted);

  if (lateToday.length >= LATE_ARRIVAL_ALERT_THRESHOLD && !alreadyAlerted) {
    const lines = lateToday.slice(0, 10).map((t) => `• ${t.tripNum} (${t.routeName}) - ${t.vendorName}`);
    const text =
      `🔴 ALERT: Late Arrival Numpuk - SOC\n` +
      `${lateToday.length} trip Late Arrival hari ini (ambang batas ${LATE_ARRIVAL_ALERT_THRESHOLD}):\n` +
      lines.join("\n") +
      (lateToday.length > 10 ? "\n…dan lainnya" : "") +
      "\nCek detail di modul Inbound ya.";
    await sendSeatalkGroupMessage(token, groupId, text);
    await stateRef.update({ lateArrivalAlerted: true, lateArrivalCount: lateToday.length });
  } else if (lateToday.length < LATE_ARRIVAL_ALERT_THRESHOLD && alreadyAlerted) {
    await stateRef.update({ lateArrivalAlerted: false });
  }
}

async function checkRestOvertime(groupId, token) {
  const data = await getRestAssetData();
  const status = computeRestAssetLiveStatus(data.logs, data.assetLogs, data.master, data.stationMap);

  if (!status.operatorIstirahatLebih60Menit.length) return;

  // Reminder ulang tiap run (tiap 1 jam) buat SEMUA operator yang masih
  // kena kondisi ini — sengaja TANPA dedup, karena requirement-nya emang
  // mau di-reminder terus selama masih berlangsung.
  const lines = status.operatorIstirahatLebih60Menit.map(
    (o) => `• ${o.nama} (${o.opsId}, ${o.agency}) - udah ${o.durasiMenit} menit sejak ${o.jamBreakOut}`
  );
  const text = `⏳ REMINDER: Operator Masih Istirahat >60 Menit - SOC\n${lines.join("\n")}\nCek Rest Time Monitoring ya.`;
  await sendSeatalkGroupMessage(token, groupId, text);
}

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  let token;
  try {
    token = await getSeatalkAccessToken();
  } catch (err) {
    console.error("Gagal ambil token SeaTalk:", err);
    return { statusCode: 500, body: "gagal ambil token" };
  }

  try {
    await checkLateArrival(groupId, token);
  } catch (err) {
    console.error("Gagal cek Late Arrival:", err);
  }

  try {
    await checkRestOvertime(groupId, token);
  } catch (err) {
    console.error("Gagal cek Rest Overtime:", err);
  }

  return { statusCode: 200, body: "ok" };
};
