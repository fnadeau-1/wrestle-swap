/**
 * Cloud Function: deleteSoldProducts
 * Automatically deletes products sold 90+ days ago
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

exports.deleteSoldProducts = functions.https.onRequest(async (req, res) => {
  try {
    console.log("Starting deletion of old sold products...");

    const db = admin.firestore();
    const productsRef = db.collection("products");
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);

    const querySnapshot = await productsRef
        .where("sold", "==", true)
        .where("soldTimestamp", "<=", ninetyDaysAgo)
        .get();

    if (querySnapshot.empty) {
      console.log("No sold products older than 90 days found.");
      return res.status(200).json({
        success: true,
        message: "No products to delete",
        deletedCount: 0,
      });
    }

    const batchSize = 500;
    let deletedCount = 0;
    let batch = db.batch();
    let operationCount = 0;

    for (const doc of querySnapshot.docs) {
      const productData = doc.data();
      const soldDate = new Date(productData.soldTimestamp)
          .toLocaleDateString();
      const productName = productData.name || "Unnamed";
      console.log(`Deleting: ${doc.id} (${productName}) - Sold: ${soldDate}`);

      batch.delete(doc.ref);
      operationCount++;
      deletedCount++;

      if (operationCount >= batchSize) {
        await batch.commit();
        console.log(`Committed batch of ${operationCount} deletions`);
        batch = db.batch();
        operationCount = 0;
      }
    }

    if (operationCount > 0) {
      await batch.commit();
      console.log(`Committed final batch of ${operationCount} deletions`);
    }

    const message = `Deleted ${deletedCount} sold products older than 90 days`;
    console.log(`Successfully ${message.toLowerCase()}`);

    return res.status(200).json({
      success: true,
      message: message,
      deletedCount: deletedCount,
    });
  } catch (error) {
    console.error("Error deleting sold products:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});