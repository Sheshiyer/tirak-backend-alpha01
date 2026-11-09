import { firstProfileImage } from './profileImages';

/** Full-dataset aggregates. Booking face value is not evidence of cash collection. */
export async function guideStats(db: D1Database, id: string) {
  const profile: any = await db.prepare('SELECT * FROM supplier_profiles WHERE user_id=?').bind(id).first();
  if (!profile) return null;
  const [totals, reviews, periods, services] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total, SUM(status='completed') AS completed, SUM(status='cancelled') AS cancelled,
      COUNT(DISTINCT CASE WHEN status!='cancelled' THEN currency END) AS currencies,
      MIN(CASE WHEN status!='cancelled' THEN currency END) AS currency,
      COALESCE(SUM(CASE WHEN status!='cancelled' THEN total_amount ELSE 0 END),0) AS booked_value
      FROM bookings WHERE supplier_id=?`).bind(id).first<any>(),
    db.prepare('SELECT COUNT(*) AS total, AVG(rating) AS rating FROM reviews WHERE reviewee_id=? AND is_public=TRUE').bind(id).first<any>(),
    db.prepare(`SELECT strftime('%Y-%m', scheduled_at) AS month,
      strftime('%Y', scheduled_at) || '-W' || strftime('%W', scheduled_at) AS week,
      strftime('%Y', scheduled_at) || '-Q' || ((CAST(strftime('%m', scheduled_at) AS INTEGER) + 2) / 3) AS quarter,
      COUNT(*) AS bookings FROM bookings WHERE supplier_id=? GROUP BY month,week,quarter ORDER BY month,week`).bind(id).all<any>(),
    db.prepare(`SELECT s.id,s.title AS name,COUNT(b.id) AS bookings FROM bookings b LEFT JOIN supplier_services s ON s.id=b.service_id
      WHERE b.supplier_id=? GROUP BY b.service_id ORDER BY bookings DESC,s.id`).bind(id).all<any>(),
  ]);
  const array = (value: unknown): string[] => { try { const parsed = JSON.parse(String(value || '[]')); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
  const bucket = (key: 'month' | 'week' | 'quarter') => {
    const grouped = new Map<string, number>();
    for (const row of periods.results) {
      if (row[key]) grouped.set(row[key], (grouped.get(row[key]) || 0) + Number(row.bookings));
    }
    return [...grouped].map(([label, bookings]) => ({ [key]: label, bookings, earnings: null, rating: null }));
  };
  const languages = array(profile.spoken_languages), categories = array(profile.categories), regions = array(profile.regions);
  return {
    user: { name: profile.display_name, profileImage: firstProfileImage(profile.profile_images), bio: profile.bio,
      location: regions[0], languages, specialization: categories, status: profile.verification_status,
      totalRatings: Number(reviews?.total || 0), totalReviews: Number(reviews?.total || 0) },
    data: {
      totalBookings: Number(totals?.total || 0), completedBookings: Number(totals?.completed || 0), cancelledBookings: Number(totals?.cancelled || 0),
      totalEarnings: null, thisMonthEarnings: null, lastMonthEarnings: null, earningsBasis: 'unavailable',
      bookedValue: Number(totals?.currencies || 0) <= 1 ? Number(totals?.booked_value || 0) : null,
      currency: Number(totals?.currencies || 0) <= 1 ? totals?.currency || 'THB' : null,
      timeZone: 'Asia/Bangkok', periodBasis: 'scheduled_date',
      profileViews: null, responseRate: null, responseTime: null,
      averageRating: reviews?.rating == null ? null : Math.round(Number(reviews.rating) * 10) / 10,
      totalReviews: Number(reviews?.total || 0),
      profileCompletion: Math.round([profile.display_name?.trim(), profile.bio?.trim(), firstProfileImage(profile.profile_images), languages.length, categories.length, regions.length].filter(Boolean).length / 6 * 100),
      monthlyStats: bucket('month'), weeklyStats: bucket('week'), quarterStats: bucket('quarter'),
      servicePerformance: services.results.map(row => ({ id: row.id, name: row.name, bookings: Number(row.bookings), rating: null, earnings: null })),
    },
  };
}
