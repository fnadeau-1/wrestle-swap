const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

exports.deleteSoldProducts = functions.https.onRequest(async (req, res) => {
  try {
    const db = admin.firestore();
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
    
    const snapshot = await db.collection("products")
      .where("sold", "==", true)
      .where("soldTimestamp", "<=", ninetyDaysAgo)
      .get();
    
    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        deletedCount: 0,
      });
    }
    
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    
    return res.status(200).json({
      success: true,
      deletedCount: snapshot.size,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});