const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
try {
  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  };
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase initialized");
} catch (error) {
  console.log("⚠️ Firebase error:", error.message);
}
const db = admin.firestore();

// Middleware
app.use(cors());
app.use(express.json());

// Store payment attempts in memory
const payments = new Map();

// Health check
app.get("/", (req, res) => {
  res.json({ 
    message: "Blackecho Payment Backend",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

// INITIATE PAYMENT
app.post("/api/payments/initiate", async (req, res) => {
  try {
    const { phone, amount, plan, userId } = req.body;
    
    console.log(`💰 Payment requested: ${amount} KES to ${phone}`);
    
    // Format phone
    let formattedPhone = phone.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    
    const checkoutId = `CHK_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const reference = `BLACK${Date.now()}`;
    
    // Save to Firebase
    await db.collection('paymentAttempts').doc(checkoutId).set({
      userId,
      phone: formattedPhone,
      amount,
      plan,
      status: 'pending',
      checkoutId,
      reference,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Store in memory
    payments.set(checkoutId, { userId, phone: formattedPhone, amount, plan, status: 'pending' });
    
    console.log(`📱 STK Push initiated to ${formattedPhone}`);
    
    res.json({
      success: true,
      message: "STK Push sent successfully",
      checkoutRequestId: checkoutId,
      reference: reference
    });
    
  } catch (error) {
    console.error("Payment error:", error);
    res.status(500).json({
      success: false,
      message: "Payment initiation failed",
      error: error.message
    });
  }
});

// MPESA CALLBACK (Webhook)
app.post("/api/mpesa/callback", async (req, res) => {
  console.log("📞 Webhook received:", JSON.stringify(req.body, null, 2));
  
  const callbackData = req.body;
  const checkoutId = callbackData?.Body?.stkCallback?.CheckoutRequestID;
  const resultCode = callbackData?.Body?.stkCallback?.ResultCode;
  
  if (checkoutId) {
    const payment = payments.get(checkoutId);
    
    if (resultCode === 0) {
      // Payment successful
      if (payment) {
        payment.status = 'completed';
        payments.set(checkoutId, payment);
        
        // Update Firebase
        await db.collection('paymentAttempts').doc(checkoutId).update({
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Activate premium subscription
        if (payment.userId) {
          const endDate = new Date();
          endDate.setDate(endDate.getDate() + 30);
          
          await db.collection('subscriptions').doc(payment.userId).set({
            userId: payment.userId,
            plan: payment.plan,
            amount: payment.amount,
            currency: 'KES',
            status: 'active',
            startDate: admin.firestore.FieldValue.serverTimestamp(),
            endDate: admin.firestore.Timestamp.fromDate(endDate),
            autoRenew: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          
          console.log(`✅ Premium activated for user: ${payment.userId}`);
        }
      }
      console.log(`✅ Payment successful: ${checkoutId}`);
    } else {
      // Payment failed
      if (payment) {
        payment.status = 'failed';
        payments.set(checkoutId, payment);
      }
      await db.collection('paymentAttempts').doc(checkoutId).update({
        status: 'failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`❌ Payment failed: ${checkoutId}`);
    }
  }
  
  res.json({
    ResultCode: 0,
    ResultDesc: "Success"
  });
});

// CHECK PAYMENT STATUS
app.get("/api/payments/status/:checkoutId", async (req, res) => {
  const { checkoutId } = req.params;
  
  try {
    const doc = await db.collection('paymentAttempts').doc(checkoutId).get();
    if (doc.exists) {
      res.json({
        success: true,
        status: doc.data().status,
        payment: doc.data()
      });
    } else if (payments.has(checkoutId)) {
      res.json({
        success: true,
        status: payments.get(checkoutId).status
      });
    } else {
      res.json({
        success: false,
        status: 'not_found'
      });
    }
  } catch (error) {
    res.json({
      success: false,
      status: 'error',
      error: error.message
    });
  }
});

// Test endpoint
app.get("/api/test", (req, res) => {
  res.json({
    status: "online",
    service: "M-Pesa Payment Gateway",
    business: process.env.BUSINESS_NAME || "Blackecho",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
