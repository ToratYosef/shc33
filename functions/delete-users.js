const admin = require('firebase-admin');

// Replace with the path to your service account key file
const serviceAccount = require('/workspaces/BuyBacking/admin/serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const listAllUsers = async (nextPageToken) => {
  try {
    const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);
    const uids = listUsersResult.users.map(userRecord => userRecord.uid);

    console.log(`Deleting ${uids.length} users...`);

    // Deletes all specified users
    if (uids.length > 0) {
      await admin.auth().deleteUsers(uids);
      console.log(`Successfully deleted ${uids.length} users.`);
    }

    if (listUsersResult.pageToken) {
      // List next batch of users
      await listAllUsers(listUsersResult.pageToken);
    } else {
      console.log('Finished deleting all users.');
    }

  } catch (error) {
    console.error('Error listing or deleting users:', error);
  }
};

// Start the process
listAllUsers();