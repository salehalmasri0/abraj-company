import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': 'https://horses2002.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})
const normalize = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const maskPhone = (phone: string) => {
  const clean = String(phone || '').replace(/\s+/g, '')
  return clean.length > 6 ? `${clean.slice(0, 4)}••••${clean.slice(-2)}` : 'الهاتف المسجل'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const { nationalId } = await req.json()
    const nid = normalize(nationalId)
    if (!/^\d{8,20}$/.test(nid)) return json({ error: 'رقم وطني غير صالح.' }, 400)

    // National-ID lookup stays server-side. The secret key never reaches the browser.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SECRET_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    )

    const { data: employee, error } = await admin
      .from('employees')
      .select('id, phone, status')
      .eq('national_id', nid)
      .eq('status', 'active')
      .maybeSingle()

    if (error || !employee?.phone) return json({ error: 'تعذر التحقق من البيانات المدخلة.' }, 404)

    const { error: otpError } = await admin.auth.signInWithOtp({ phone: String(employee.phone) })
    if (otpError) {
      console.error(otpError)
      return json({ error: 'تعذر إرسال رمز التحقق. حاول لاحقًا.' }, 503)
    }

    return json({ ok: true, maskedPhone: maskPhone(String(employee.phone)) })
  } catch (error) {
    console.error(error)
    return json({ error: 'حدث خطأ داخلي. حاول لاحقًا.' }, 500)
  }
})
