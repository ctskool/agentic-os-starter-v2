// Everyday words that fill note and folder names. Speech-to-text already hears these correctly, so they are
// never put on the list of words to listen for (voice-words.mjs): the list is short, and every place on it
// should go to a name it would otherwise get wrong. Erring on the side of leaving a word off this file only
// costs a place on that list; putting a real name here would stop voice learning it.
export const EVERYDAY_WORDS = new Set(`
a about above account accounts action actions active add added advanced after again agent agents alert alerts all alpha also am an analysis and angle angles animation
answer answers any api app apps archive are area article articles as ask asset assets at audience audio audit auto automation automations average back backlog backup
bad basic batch be because been before beginner being below best beta better between big bill blog board body bonus book books bot bots both bottom box brand branch
brief briefs budget bug bugs build builds business but button buttons buy by calendar call calls camera can caption captions card cards carousel carousels cascade
cascades case cases chain change changes channel channels chapter chart charts chat cheap cheaper check checks choice choices choose class classifier clean clear click
clicks client clients clip clips close cloud code collection color colors column come comment comments commit community company compare comparison complete complex
config connect cons content contract contracts control conversion convert copy cost costs could count course cover create creator creators current custom customer
customers daily dark dashboard data database date day days deal deals debug dec decide deck deep default delete demo design designs desktop detail details dev did
directory do doc docs document documentation does doing done down download draft drafts during each early easy edit editing editor education email emails end energy
engine entries entry episode episodes error errors event events every example examples expense expenses experiment export extension fast faster feature features feedback
few field file files final finance find first fitness five fix fixes flight flow flows focus folder follow followers font fonts food for form format forms forward four
frame frames free from full fun game games general generate generation get getting gift global go goal goals going good got graph gratitude great group growth guide
guides habit habits had half hard has have having he health help her here hers hide high him his history home hook hooks hot hotel how human i idea ideas if image
images import important improve improvement in inbox income index info input insight insights install integration intel intro into invoice invoices is issue issues it
item items its job journal just key keys kit know lab landing large last later latest launch layout lead leads learn learning legal less lesson lessons level levels
library light like likes line lines link links list listen live local log login logo logos logs long look loop loss low made mail main make making manual many map maps
market marketing may me media meeting member members merge message messages metric metrics migration milestone mind mini misc mobile mode model models money monitor
month monthly months mood more morning most motion move much music my name names need new news next night no not note notes now number numbers of off offer office
official old on once one online only open ops option options or order original other our out outlier outliers outline outlines output outro over overview own package
page pages paid paper papers part partner partners path pause payment payments people person personal phone photo photos pick picture pictures pipeline plan plans
platform play player plugin plugins podcast policy poll post posts premium preview previous price pricing priorities priority privacy private pro problem process
product products profile profit program project projects prompt prompts proposal proposals pros public publish pull push query question questions queue quick quiz radar
rank ranking rate rating raw read readme real record recording reel reels reference reflection release remote remove render reply repo report reports repos request
requests research reset response rest restore result results resume retro revenue review reviews right roadmap room routine row rule rules run runs sale sales same
sample save say schedule school score scores screen screenshot screenshots script scripts search season second section security see send series server servers service
session set settings setup share she short shorts should show side simple site sites size skill skills sleep slide slides slow small so social some sound source space
speak special speed sponsor sponsors sprint stable stage standard start starter state status step steps still stop storage stories story strategy stream studio study
style styles subscribers such summary support survey sync system systems table tables tag tags take talk target task tasks tax taxes team teams tech tell template
templates test tests text than that the their them theme themes then there these they thing things think third this those three through thumbnail thumbnails tier time
timeline tip tips title titles to today todo token tokens tomorrow too tool tools top topic topics total trace track traffic training transform travel tree trend
trending trends trial trip tutorial two type under untitled up update updates upgrade upload urgent url us use used user users using value version versus very video
videos view views visual voice vote vs want was watch way we web website week weekly weeks well were what when where which while who why will win wins with word words
work workflow workflows world worst would write year years yes yesterday you your zero
january february march april june july august september october november december jan feb mar apr jun jul aug sep sept oct nov
monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun`.split(/\s+/).filter(Boolean));
