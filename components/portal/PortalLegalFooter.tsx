// components/portal/PortalLegalFooter.tsx
//
// Signers and clients reach the portal from an emailed link and never pass through sign-up, so this is the only place
// they can find out how their data is handled. Both the Terms and the Privacy Policy say they cover sign.scopegov.app;
// this footer is what makes that discoverable (and the portal records signer details — signature, time, IP address and
// browser — so the transparency link is not optional). Links open in a NEW tab: a signer who clicks one mid-signature
// must not lose the half-drawn signature or typed name.
export default function PortalLegalFooter() {
  return (
    <div
      className="portal-legal-footer"
      style={{ padding: '24px 32px 32px', textAlign: 'center', fontSize: 11.5, color: '#909090', lineHeight: 1.7 }}
    >
      <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>Privacy Policy</a>
      <span aria-hidden="true"> &middot; </span>
      <a href="/legal/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>Terms</a>
    </div>
  )
}
