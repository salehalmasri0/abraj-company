import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': 'https://horses2002.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

const normalize = (v: unknown) => String(v ?? '').replace(/\D/g, '')

const maskPhone = (phone: string) => {
  if (!phone) return 'الهاتف المسجل'
  const clean = phone.replace(/\s+/g, '')
  return clean.length > 6 ? `${clean.slice(0, 4)}••••${clean.slice(-2)}` : 'الهاتف المسجل'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { nationalId } = await req.json()
    const nid = normalize(nationalId)
    if (!/^\d{8,20}$/.test(nid)) return json({ error: 'رقم وطني غير صالح.' }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const { data: employee, error } = await supabase
      .from('employees')
      .select('id, phone, status')
      .eq('national_id', nid)
      .eq('status', 'active')
      .maybeSingle()

    // Deliberately return the same message for unknown/inactive employees.
    if (error || !employee?.phone) return json({ error: 'تعذر التحقق من البيانات المدخلة.' }, 404)

    const phone = String(employee.phone)
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone })
    if (otpError) {
      console.error(otpError)
      return json({ error: 'تعذر إرسال رمز التحقق. حاول لاحقًا.' }, 503)
    }

    return json({ ok: true, maskedPhone: maskPhone(phone) })
  } catch (error) {
    console.error(error)
    return json({ error: 'حدث خطأ داخلي. حاول لاحقًا.' }, 500)
  }
})
