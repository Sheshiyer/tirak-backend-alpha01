import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {reviewRoutes} from '@/routes/reviews';
import {generateJWT} from '@/utils/auth';
import {createTestEnv,createTestUser} from '@tests/setup';

describe('Core completed-booking reviews',()=>{
 const bookingId='123e4567-e89b-12d3-a456-426614174000';
 const supplierId='223e4567-e89b-12d3-a456-426614174000';
 let env:any,user:any,token:string,app:Hono,eligible:boolean,existing:boolean;
 let insert:ReturnType<typeof vi.fn>,eligibility:ReturnType<typeof vi.fn>;
 beforeEach(async()=>{
  env=createTestEnv();user=createTestUser({id:'customer-core-review'});eligible=true;existing=false;insert=vi.fn();eligibility=vi.fn();
  token=await generateJWT({sub:user.id,email:user.email,userType:user.userType},env.JWT_SECRET);
  env.DB.prepare=(sql:string)=>({bind:(...args:any[])=>({
   first:async()=>{
    if(sql.includes('FROM users WHERE id'))return user;
    if(sql.includes('FROM bookings')){
     // Enforce the canonical Core schema: this table has supplier_id, not companion_id.
     if(sql.includes('companion_id'))throw new Error('no such column: companion_id');
     expect(sql).toContain("status = 'completed'");eligibility(...args);
     return eligible?{id:bookingId,customer_id:user.id,supplier_id:supplierId,status:'completed'}:null;
    }
    if(sql.includes('FROM reviews WHERE booking_id'))return existing?{id:'already-reviewed'}:null;
    if(sql.includes('AVG(rating)'))return{avg_rating:4,review_count:1};
    if(sql.includes('JOIN customer_profiles'))return{id:'created-review',booking_id:bookingId,reviewee_id:supplierId,reviewer_id:user.id,rating:4,comment:'A genuine completed-booking review',created_at:'2026-10-22T00:00:00Z'};
    return null;
   },run:async()=>{if(sql.includes('INSERT INTO reviews'))insert(...args);return{success:true};},all:async()=>({results:[]})
  })});app=new Hono();app.route('/reviews',reviewRoutes);
 });
 const post=()=>app.request('http://local.test/reviews',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({bookingId,companionId:supplierId,rating:4,comment:'A genuine completed-booking review'})},env);
 it('uses Core supplier ownership and accepts an eligible customer completed booking',async()=>{
  const res=await post();expect(res.status).toBe(201);expect(eligibility).toHaveBeenCalledWith(bookingId,user.id,supplierId);expect(insert).toHaveBeenCalledTimes(1);expect((await res.json() as any).data.review.companionId).toBe(supplierId);
 });
 it('rejects missing, unowned or incomplete booking eligibility before inserting',async()=>{eligible=false;const res=await post();expect(res.status).toBe(404);expect(insert).not.toHaveBeenCalled();});
 it('rejects a duplicate review before inserting',async()=>{existing=true;const res=await post();expect(res.status).toBe(409);expect(insert).not.toHaveBeenCalled();});
 it('rejects guide-role review creation before inspecting booking eligibility',async()=>{user.userType='supplier';user.user_type='supplier';token=await generateJWT({sub:user.id,email:user.email,userType:'supplier'},env.JWT_SECRET);const res=await post();expect(res.status).toBe(403);expect(eligibility).not.toHaveBeenCalled();expect(insert).not.toHaveBeenCalled();});
});
