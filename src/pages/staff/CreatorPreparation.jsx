import {useAuth} from '../../context/AuthContext.jsx'
import {navigateTo} from '../../utils/routes.js'
import LocalLibraryPreview from './LocalLibraryPreview.jsx'

export default function CreatorPreparation(){
 const {user,signOut}=useAuth()
 async function exit(){
  const response=await signOut()
  if(response?.error)throw response.error
  navigateTo('/testcreator/login')
 }
 return <LocalLibraryPreview connected account={user} onSignOut={exit}/>
}
