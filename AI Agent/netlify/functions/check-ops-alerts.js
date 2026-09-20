/**
 * netlify/functions/check-ops-alerts.js
 * ------------------------------------------------------------------
 * Scheduled Function (jalan tiap 15 MENIT, jadwal di netlify.toml).
 * Ngecek 2 kondisi operasional:
 *
 *   1. Late Arrival numpuk hari ini (Inbound) — alert SEKALI per hari,
 *      begitu jumlahnya nembus LATE_ARRIVAL_ALERT_THRESHOLD. Reset
 *      otomatis kalau angkanya turun lagi di bawah ambang batas
 *      (misal ada koreksi data).
 *   2. Operator istirahat >60 menit (Rest Time) — alert SEKALI per
 *      "episode" break-out (dedup by opsId + jamBreakOut, disimpen di
 *      Firebase prDcMonitoring/restAlertState). HANYA buat Break Out
 *      yang kejadian HARI INI — log lama (kemarin/lebih) yang gak
 *      sempet ke-"Break In" (data nyangkut) sengaja DIABAIKAN di sini,
 *      biar alert gak numpuk sama history basi. Getter data-nya sendiri
 *      (getRestAssetData) tetep narik window 3 hari, karena dipakai
 *      juga sama chatbot buat jawab pertanyaan manual — filter "hari
 *      ini" cuma diterapin di alert otomatis ini.
 *      Begitu operatornya balik kerja (gak overtime lagi), flag-nya
 *      di-reset otomatis, jadi kalau dia break lagi nanti dan overtime
 *      lagi, bakal ke-alert lagi sebagai episode baru.
 *
 * State notifikasi disimpen di Firebase (bukan di memory function,
 * karena tiap invocation Netlify Function itu proses baru).
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

// Dedup per opsId + jamBreakOut. Kalau opsId yang sama masih di jamBreakOut
// yang sama persis dengan yang udah dinotif -> skip (masih episode yang
// sama). Kalau jamBreakOut beda (break baru) atau belum pernah dinotif ->
// dianggap "baru", alert. HANYA operator yang jamBreakOut-nya HARI INI.
async function checkRestOvertime(groupId, token) {
  const data = await getRestAssetData();
  const status = computeRestAssetLiveStatus(data.logs, data.assetLogs, data.master, data.stationMap);

  const today = todayStr();
  const overtimeToday = status.operatorIstirahatLebih60Menit.filter(
    (o) => o.jamBreakOut && o.jamBreakOut.slice(0, 10) === today
  );

  const stateRef = db().ref("prDcMonitoring/restAlertState");
  const stateSnap = await stateRef.get();
  const state = stateSnap.val() || {};

  const currentOpsIds = new Set(overtimeToday.map((o) => o.opsId));

  const newlyOver = overtimeToday.filter((o) => {
    const s = state[o.opsId];
    return !(s && s.notified === true && s.jamBreakOut === o.jamBreakOut);
  });

  const updates = {};

  // Reset flag buat opsId yang sebelumnya kena alert tapi sekarang udah
  // gak overtime lagi HARI INI (balik kerja, atau log-nya udah basi dari
  // hari kemarin) -> episode berikutnya bisa ke-alert lagi.
  Object.keys(state).forEach((opsId) => {
    if (state[opsId].notified === true && !currentOpsIds.has(opsId)) {
      updates[`prDcMonitoring/restAlertState/${opsId}/notified`] = false;
    }
  });

  if (newlyOver.length) {
    const lines = newlyOver.map(
      (o) => `• ${o.nama} (${o.opsId}, ${o.agency}) - udah ${o.durasiMenit} menit sejak ${o.jamBreakOut}`
    );
    const text = `⏳ ALERT: Operator Baru Kena Istirahat >60 Menit - SOC\n${lines.join("\n")}\nCek Rest Time Monitoring ya.`;
    await sendSeatalkGroupMessage(token, groupId, text);
    newlyOver.forEach((o) => {
      updates[`prDcMonitoring/restAlertState/${o.opsId}`] = {
        notified: true,
        jamBreakOut: o.jamBreakOut,
      };
    });
  }

  if (Object.keys(updates).length) {
    await db().ref().update(updates);
  }
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
