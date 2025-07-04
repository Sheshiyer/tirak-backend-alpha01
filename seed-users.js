// Seed script for 10 companions and 10 customers with Thai/Asian names, all other fields in English
const { faker } = require('@faker-js/faker');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'dev.db'));

function randomThaiName() {
  const firstNames = ['Somchai', 'Orathai', 'Wichai', 'Supaporn', 'Preecha', 'Siriporn', 'Anan', 'Jaruwan'];
  const lastNames = ['Sukjai', 'Thongdee', 'Jaidee', 'Srisuk', 'Wattanakul', 'Boonmee', 'Rattanakul', 'Janphen'];
  return {
    first: faker.helpers.arrayElement(firstNames),
    last: faker.helpers.arrayElement(lastNames)
  };
}

function randomThaiImage(gender = 'male') {
  const idx = faker.number.int({ min: 1, max: 99 });
  return gender === 'male'
    ? `https://randomuser.me/api/portraits/men/${idx}.jpg`
    : `https://randomuser.me/api/portraits/women/${idx}.jpg`;
}

function createCompanion(id) {
  const { first, last } = randomThaiName();
  const email = faker.internet.email({ firstName: first, lastName: last, provider: 'example.com' });
  const phone = faker.phone.number('08########');
  const gender = faker.helpers.arrayElement(['male', 'female']);
  const profilePhoto = randomThaiImage(gender);
  const coverPhoto = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80';
  const displayName = `${first} ${last}`;
  const location = faker.helpers.arrayElement(['Bangkok', 'Chiang Mai', 'Phuket', 'Pattaya', 'Ayutthaya', 'Hua Hin', 'Khon Kaen', 'Udon Thani']);
  const languages = JSON.stringify(['th', 'en']);
  const specialization = JSON.stringify(['City Tours', 'Nightlife']);
  const now = new Date().toISOString();
  const bio = `Professional tour guide in ${location}`;

  return {
    user: [id, email, phone, 'companion', 'active', 1, 1, 'th', now, now],
    profile: [id, first, last, displayName, profilePhoto, coverPhoto, bio, null, null, gender, location, languages, specialization, null, now, now]
  };
}

function createCustomer(id) {
  const { first, last } = randomThaiName();
  const email = faker.internet.email({ firstName: first, lastName: last, provider: 'example.com' });
  const phone = faker.phone.number('09########');
  const displayName = `${first} ${last}`;
  const profileImage = randomThaiImage('female');
  const now = new Date().toISOString();

  return {
    user: [id, email, phone, 'customer', 'active', 1, 1, 'th', now, now],
    profile: [id, displayName, profileImage, JSON.stringify({ language: 'th' }), now, now]
  };
}

function insertCompanion(companion) {
  db.run(
    `INSERT INTO users (id, email, phone, user_type, status, email_verified, phone_verified, preferred_language, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companion.user
  );
  db.run(
    `INSERT INTO companion_profiles (user_id, first_name, last_name, display_name, profile_photo, cover_photo, bio, social_links, date_of_birth, gender, location, languages, specialization, certifications, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companion.profile
  );
}

function insertCustomer(customer) {
  db.run(
    `INSERT INTO users (id, email, phone, user_type, status, email_verified, phone_verified, preferred_language, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    customer.user
  );
  db.run(
    `INSERT INTO customer_profiles (user_id, display_name, profile_image, preferences, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    customer.profile
  );
}

db.serialize(() => {
  for (let i = 0; i < 10; i++) {
    const id = faker.string.uuid();
    insertCompanion(createCompanion(id));
  }
  for (let i = 0; i < 10; i++) {
    const id = faker.string.uuid();
    insertCustomer(createCustomer(id));
  }
  console.log('Seeded 10 companions and 10 customers with Thai/Asian names and English details.');
});

db.close();
