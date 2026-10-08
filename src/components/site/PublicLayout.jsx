// Older public pages (LMS sections, demo test, preview) keep their content but now use the
// redesigned site header and footer. The classic homepage uses PublicLayoutClassic.jsx.
import SiteLayout from './SiteLayout.jsx'
import './public-site.css'
export default function PublicLayout({children}){
 return <SiteLayout><div className="ksc-public ksc-public-content">{children}</div></SiteLayout>
}
