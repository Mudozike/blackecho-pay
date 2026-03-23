const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin using secret file
try {
  const serviceAccount = require('/etc/secrets/firebase-key.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("? Firebase initialized from secret file");
} catch (error) {
  console.log("?? Firebase error:", error.message);
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

// ?? INITIATE PAYMENT - REAL LIPANA INTEGRATION
app.post("/api/payments/initiate", async (req, res) => {
  try {
    const { phone, amount, plan, userId } = req.body;
    
    console.log(`?? Payment requested: ${amount} KES to ${phone} for plan: ${plan}`);
    
    // Format phone number - Lipana expects +254 format
    let formattedPhone = phone.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '+254' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('254')) {
      formattedPhone = '+' + formattedPhone;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }
    
    const checkoutId = `CHK_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const reference = `BLACK${Date.now()}`;
    
    // ?? CALL LIPANA API FOR REAL STK PUSH
    let lipanaResponse;
    try {
      lipanaResponse = await axios.post(
        'https://api.lipana.dev/v1/transactions/push-stk',
        {
          phone: formattedPhone,
          amount: Math.round(amount)
        },
        {
          headers: {
            'x-api-key': process.env.LIPANA_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log('?? Lipana Response:', lipanaResponse.data);
    } catch (lipanaError) {
      console.error('Lipana API Error:', lipanaError.response?.data || lipanaError.message);
      return res.status(400).json({
        success: false,
        message: "Failed to initiate STK Push",
        error: lipanaError.response?.data?.message || lipanaError.message
      });
    }
    
    // Save to Firebase
    await db.collection('paymentAttempts').doc(checkoutId).set({
      userId,
      phone: formattedPhone,
      amount,
      plan,
      status: 'pending',
      checkoutId,
      reference,
      lipanaTransactionId: lipanaResponse.data?.data?.transactionId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Store in memory
    payments.set(checkoutId, { 
      userId, 
      phone: formattedPhone, 
      amount, 
      plan, 
      status: 'pending',
      lipanaTransactionId: lipanaResponse.data?.data?.transactionId
    });
    
    console.log(`?? STK Push sent to ${formattedPhone}`);
    
    res.json({
      success: true,
      message: "STK Push sent successfully",
      checkoutRequestId: checkoutId,
      reference: reference,
      lipanaTransactionId: lipanaResponse.data?.data?.transactionId
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

// ?? MPESA CALLBACK (Lipana Webhook)
app.post("/api/mpesa/callback", async (req, res) => {
  console.log("?? Webhook received:", JSON.stringify(req.body, null, 2));
  
  const callbackData = req.body;
  const event = callbackData?.event;
  const eventData = callbackData?.data;
  const transactionId = eventData?.transactionId;
  const checkoutId = eventData?.checkoutRequestID;
  const amount = eventData?.amount;
  const mpesaReceipt = eventData?.mpesaReceiptNumber;
  
  // Find payment by transactionId or checkoutId
  let payment = null;
  if (checkoutId && payments.has(checkoutId)) {
    payment = payments.get(checkoutId);
  } else {
    // Search in Firebase if not in memory
    const snapshot = await db.collection('paymentAttempts')
      .where('lipanaTransactionId', '==', transactionId)
      .limit(1)
      .get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      payment = { userId: doc.data().userId, plan: doc.data().plan, amount: doc.data().amount };
      checkoutId = doc.id;
    }
  }
  
  if (event === 'transaction.success') {
    // Payment successful
    if (payment) {
      if (checkoutId) payments.set(checkoutId, { ...payment, status: 'completed', mpesaReceipt });
      
      // Update Firebase
      await db.collection('paymentAttempts').doc(checkoutId).update({
        status: 'completed',
        mpesaReceipt: mpesaReceipt,
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
          mpesaReceipt: mpesaReceipt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        console.log(`? Premium activated for user: ${payment.userId}`);
      }
      console.log(`? Payment successful: ${transactionId}`);
    }
  } else if (event === 'transaction.failed') {
    // Payment failed
    if (payment && checkoutId) {
      if (checkoutId) payments.set(checkoutId, { ...payment, status: 'failed' });
      await db.collection('paymentAttempts').doc(checkoutId).update({
        status: 'failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`? Payment failed: ${transactionId}`);
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
  console.log(`? Backend running on http://localhost:${PORT}`);
  console.log(`?? Environment: ${process.env.MPESA_ENVIRONMENT || 'development'}`);
});

