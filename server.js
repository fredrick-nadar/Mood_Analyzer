// server.js - Main Express Server
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  clientId: process.env.FIREBASE_CLIENT_ID
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: 'https://mood-analyze.netlify.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));
app.use(express.json());
// app.use(express.static('static'));

// Initialize Firebase Admin SDK

const db = admin.firestore();

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.userId = decodedToken.uid;
    req.userEmail = decodedToken.email;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.userId).get();
    
    if (!userDoc.exists) {
      // Create user profile if it doesn't exist
      const userData = {
        email: req.userEmail,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        totalEntries: 0,
        lastEntry: null
      };
      
      await db.collection('users').doc(req.userId).set(userData);
      return res.json(userData);
    }
    
    res.json({ id: userDoc.id, ...userDoc.data() });
  } catch (error) {
    console.error('Error getting user profile:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// Save mood entry
app.post('/api/mood/entry', authenticateToken, async (req, res) => {
  try {
    const { mood, description, sleepHours, exerciseMinutes, stressLevel, date } = req.body;
    
    // Validation
    if (!mood || mood < 1 || mood > 5) {
      return res.status(400).json({ error: 'Valid mood (1-5) is required' });
    }
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    
    const moodData = {
      userId: req.userId,
      date: date,
      mood: parseInt(mood),
      description: description || '',
      sleepHours: parseFloat(sleepHours) || 0,
      exerciseMinutes: parseInt(exerciseMinutes) || 0,
      stressLevel: parseInt(stressLevel) || 5,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Use userId_date as document ID to prevent duplicates
    const docId = `${req.userId}_${date}`;
    await db.collection('moods').doc(docId).set(moodData);
    
    // Update user stats
    await updateUserStats(req.userId, date);
    
    res.json({ message: 'Mood entry saved successfully', data: moodData });
  } catch (error) {
    console.error('Error saving mood entry:', error);
    res.status(500).json({ error: 'Failed to save mood entry' });
  }
});

// Get mood entries for a user
app.get('/api/mood/entries', authenticateToken, async (req, res) => {
  try {
    const { limit = 30, startDate, endDate } = req.query;
    
    console.log(`Fetching mood entries for user ${req.userId}, limit: ${limit}`);
    
    // Use the simplest possible query - only get documents where userId equals current user
    // No ordering, no compound queries, just a simple equality filter
    const snapshot = await db.collection('moods')
      .where('userId', '==', req.userId)
      .get();
    
    let entries = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      // Apply client-side filtering
      if (startDate && data.date < startDate) return;
      if (endDate && data.date > endDate) return;
      
      entries.push({ id: doc.id, ...data });
    });
    
    // Sort by date descending and limit on client side
    entries.sort((a, b) => b.date.localeCompare(a.date));
    entries = entries.slice(0, parseInt(limit));
    
    console.log(`Found ${entries.length} mood entries`);
    
    res.json(entries);
  } catch (error) {
    console.error('Error getting mood entries:', error);
    console.error('Error details:', error.stack);
    res.status(500).json({ error: 'Failed to get mood entries', details: error.message });
  }
});

// Get monthly analysis
app.get('/api/mood/analysis/:year/:month', authenticateToken, async (req, res) => {
  try {
    const { year, month } = req.params;
    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = `${year}-${month.padStart(2, '0')}-31`;
    
    console.log(`Fetching mood analysis for user ${req.userId} from ${startDate} to ${endDate}`);
    
    // Simple equality query only
    const snapshot = await db.collection('moods')
      .where('userId', '==', req.userId)
      .get();
    
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Client-side date filtering
      if (data.date >= startDate && data.date <= endDate) {
        entries.push(data);
      }
    });
    
    // Client-side sorting
    entries.sort((a, b) => a.date.localeCompare(b.date));
    
    console.log(`Found ${entries.length} entries for analysis`);
    
    if (entries.length === 0) {
      return res.json({ message: 'No data available for this month' });
    }
    
    // Calculate statistics
    const analysis = calculateMoodAnalysis(entries);
    
    // Generate recommendations
    const recommendations = generateRecommendations(analysis, entries);
    
    res.json({
      period: `${year}-${month}`,
      totalEntries: entries.length,
      analysis,
      recommendations,
      chartData: entries.map(entry => ({
        date: entry.date,
        mood: entry.mood,
        stressLevel: entry.stressLevel
      }))
    });
  } catch (error) {
    console.error('Error getting monthly analysis:', error);
    console.error('Error details:', error.stack);
    res.status(500).json({ error: 'Failed to get monthly analysis', details: error.message });
  }
});

// Get mood trends
app.get('/api/mood/trends', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    const startDateStr = startDate.toISOString().split('T')[0];
    
    console.log(`Fetching mood trends for user ${req.userId}, last ${days} days from ${startDateStr}`);
    
    // Simple equality query only
    const snapshot = await db.collection('moods')
      .where('userId', '==', req.userId)
      .get();
    
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Client-side date filtering
      if (data.date >= startDateStr) {
        entries.push(data);
      }
    });
    
    // Client-side sorting
    entries.sort((a, b) => a.date.localeCompare(b.date));
    
    console.log(`Found ${entries.length} entries for trends analysis`);
    
    const trends = calculateTrends(entries);
    
    res.json({
      period: `Last ${days} days`,
      trends,
      entries: entries.length
    });
  } catch (error) {
    console.error('Error getting mood trends:', error);
    console.error('Error details:', error.stack);
    res.status(500).json({ error: 'Failed to get mood trends', details: error.message });
  }
});

// Delete mood entry
app.delete('/api/mood/entry/:date', authenticateToken, async (req, res) => {
  try {
    const { date } = req.params;
    const docId = `${req.userId}_${date}`;
    
    await db.collection('moods').doc(docId).delete();
    res.json({ message: 'Mood entry deleted successfully' });
  } catch (error) {
    console.error('Error deleting mood entry:', error);
    res.status(500).json({ error: 'Failed to delete mood entry' });
  }
});

// Helper functions

async function updateUserStats(userId, lastEntryDate) {
  const userRef = db.collection('users').doc(userId);
  
  try {
    await userRef.update({
      lastEntry: lastEntryDate,
      totalEntries: admin.firestore.FieldValue.increment(1)
    });
  } catch (error) {
    console.error('Error updating user stats:', error);
  }
}

function calculateMoodAnalysis(entries) {
  if (entries.length === 0) return null;
  
  const moods = entries.map(e => e.mood);
  const sleepHours = entries.map(e => e.sleepHours || 0);
  const exerciseMinutes = entries.map(e => e.exerciseMinutes || 0);
  const stressLevels = entries.map(e => e.stressLevel || 5);
  
  return {
    averageMood: (moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(2),
    averageSleep: (sleepHours.reduce((a, b) => a + b, 0) / sleepHours.length).toFixed(2),
    averageExercise: Math.round(exerciseMinutes.reduce((a, b) => a + b, 0) / exerciseMinutes.length),
    averageStress: (stressLevels.reduce((a, b) => a + b, 0) / stressLevels.length).toFixed(2),
    moodDistribution: {
      veryHappy: moods.filter(m => m === 5).length,
      happy: moods.filter(m => m === 4).length,
      neutral: moods.filter(m => m === 3).length,
      sad: moods.filter(m => m === 2).length,
      verySad: moods.filter(m => m === 1).length
    },
    bestDay: entries.find(e => e.mood === Math.max(...moods)),
    worstDay: entries.find(e => e.mood === Math.min(...moods))
  };
}

function generateRecommendations(analysis, entries) {
  const recommendations = [];
  
  if (!analysis) return recommendations;
  
  // Mood recommendations
  if (parseFloat(analysis.averageMood) < 3) {
    recommendations.push({
      category: 'Mood Improvement',
      priority: 'high',
      title: 'Focus on Mental Wellness',
      description: 'Your average mood has been below neutral. Consider speaking with a mental health professional, practicing daily mindfulness, or engaging in activities that bring you joy.',
      actionItems: ['Schedule a session with a therapist', 'Try 10 minutes of daily meditation', 'Engage in a hobby you love']
    });
  }
  
  // Sleep recommendations
  if (parseFloat(analysis.averageSleep) < 7) {
    recommendations.push({
      category: 'Sleep Optimization',
      priority: 'high',
      title: 'Improve Sleep Quality',
      description: `Your average sleep is ${analysis.averageSleep} hours. Aim for 7-9 hours of quality sleep nightly.`,
      actionItems: ['Set a consistent bedtime', 'Create a relaxing bedtime routine', 'Limit screen time before bed']
    });
  }
  
  // Exercise recommendations
  if (parseInt(analysis.averageExercise) < 30) {
    recommendations.push({
      category: 'Physical Activity',
      priority: 'medium',
      title: 'Increase Daily Movement',
      description: `You're averaging ${analysis.averageExercise} minutes of exercise. Regular physical activity can significantly improve mood.`,
      actionItems: ['Take daily 15-minute walks', 'Try bodyweight exercises', 'Find a physical activity you enjoy']
    });
  }
  
  // Stress management
  if (parseFloat(analysis.averageStress) > 6) {
    recommendations.push({
      category: 'Stress Management',
      priority: 'high',
      title: 'Reduce Stress Levels',
      description: 'Your stress levels are consistently elevated. Learning stress management techniques is crucial for overall well-being.',
      actionItems: ['Practice deep breathing exercises', 'Try progressive muscle relaxation', 'Consider yoga or tai chi']
    });
  }
  
  // Positive reinforcement
  if (parseFloat(analysis.averageMood) >= 4) {
    recommendations.push({
      category: 'Maintain Wellness',
      priority: 'low',
      title: 'Keep Up the Great Work!',
      description: 'Your mood has been consistently positive. Continue with your current healthy habits!',
      actionItems: ['Maintain your current routine', 'Share your success strategies', 'Help others on their wellness journey']
    });
  }
  
  return recommendations;
}

function calculateTrends(entries) {
  if (entries.length < 2) return null;
  
  const recentEntries = entries.slice(-7); // Last 7 days
  const olderEntries = entries.slice(-14, -7); // Previous 7 days
  
  if (recentEntries.length === 0 || olderEntries.length === 0) return null;
  
  const recentAvg = recentEntries.reduce((a, b) => a + b.mood, 0) / recentEntries.length;
  const olderAvg = olderEntries.reduce((a, b) => a + b.mood, 0) / olderEntries.length;
  
  const moodTrend = recentAvg > olderAvg ? 'improving' : recentAvg < olderAvg ? 'declining' : 'stable';
  
  return {
    moodTrend,
    recentAverage: recentAvg.toFixed(2),
    previousAverage: olderAvg.toFixed(2),
    changePercentage: (((recentAvg - olderAvg) / olderAvg) * 100).toFixed(1)
  };
}

// Serve static files (your HTML/CSS/JS frontend)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Mood Tracker Server running on port ${PORT}`);
  console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
});