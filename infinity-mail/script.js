let messages = [], composeMeta = {};
let activeFolder = 'Inbox', selectedId = null, selectionMode = false, selectedRows = new Set(), currentLabel = '';
let readFilter='all',sortOrder='newest',page=0,lastViewKey='',pageIds=[];const PAGE_SIZE=30;
let dateFilter={type:'all',from:'',to:''};
const dayStart=n=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+n);return d};
const parseDay=v=>{const [y,m,d]=v.split('-').map(Number);return new Date(y,m-1,d)};
function timeLabel(m){const a=m.daysAgo||0;if(a===0)return m.time;if(a===1)return 'Yesterday';const d=dayStart(-a);return a<7?d.toLocaleDateString('en-IN',{weekday:'short'}):d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
function dateMatch(m){
  const t=dateFilter.type;if(t==='all')return true;
  const a=m.daysAgo||0;if(t==='30')return a<=30;if(t==='60')return a<=60;
  let from=dateFilter.from?parseDay(dateFilter.from):null,to=dateFilter.to?parseDay(dateFilter.to):null;
  if(from&&to&&from>to)[from,to]=[to,from];
  const day=dayStart(-a);
  return (!from||day>=from)&&(!to||day<=to);
}
const $ = id => document.getElementById(id);
const messageList = $('messageList');
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2400)}
function visibleMessages(){
  const q=$('searchInput').value.trim().toLowerCase();
  let list=messages.filter(m=>{
    const folderMatch=activeFolder==='Inbox'?m.label==='Inbox':activeFolder==='Starred'?m.starred&&m.label!=='Trash':activeFolder==='Sent'?m.label==='Sent':activeFolder==='Drafts'?m.label==='Drafts':activeFolder==='Snoozed'?m.label==='Snoozed':activeFolder==='Important'?m.label==='Important'||(m.starred&&m.label!=='Trash'):activeFolder==='Trash'?m.label==='Trash':activeFolder==='Spam'?m.label==='Spam':m.label==='Inbox';
    const labelMatch=!currentLabel||m.label===currentLabel||m.sender.toLowerCase().includes(currentLabel.toLowerCase());
    const searchMatch=!q||[m.sender,m.address,m.subject,m.snippet].join(' ').toLowerCase().includes(q);
    const readMatch=readFilter==='all'||(readFilter==='unread'?m.unread:readFilter==='read'?!m.unread:m.starred);
    return folderMatch&&labelMatch&&searchMatch&&readMatch&&dateMatch(m);
  });
  if(sortOrder==='oldest')list=list.slice().reverse();
  return list;
}
function renderList(){
  const all=visibleMessages(),total=all.length;
  const viewKey=[activeFolder,currentLabel,$('searchInput').value.trim().toLowerCase(),readFilter,sortOrder,dateFilter.type,dateFilter.from,dateFilter.to].join('|');
  if(viewKey!==lastViewKey){page=0;lastViewKey=viewKey;selectedRows.clear();selectionMode=false}
  const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));page=Math.min(Math.max(page,0),pages-1);
  const list=all.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);pageIds=list.map(m=>m.id);messageList.innerHTML='';
  $('folderTitle').textContent=currentLabel||activeFolder;
  $('emptyState').classList.toggle('hidden',list.length!==0);
  $('pageRange').textContent=`${total?page*PAGE_SIZE+1:0}–${page*PAGE_SIZE+list.length} of ${total}`;
  $('prevPage').disabled=page===0;$('nextPage').disabled=page>=pages-1;
  list.forEach(m=>{
    const row=document.createElement('div');row.className='message-row'+(m.unread?' unread':'')+(m.id===selectedId?' selected':'')+(selectionMode?' selection-mode':'');
    row.setAttribute('role','button');row.setAttribute('tabindex','0');row.setAttribute('aria-label',`${m.sender}: ${m.subject}`);
    row.innerHTML=`<input class="message-check" type="checkbox" aria-label="Select ${escapeHtml(m.subject)}" ${selectedRows.has(m.id)?'checked':''}><div class="avatar ${m.color}">${escapeHtml(m.initials)}</div><div class="message-main"><div class="message-top"><span class="sender">${escapeHtml(m.sender)}</span><time class="message-time">${escapeHtml(timeLabel(m))}</time></div><div class="subject">${escapeHtml(m.subject)}</div><div class="snippet">${escapeHtml(m.snippet)}</div></div><button class="star-btn ${m.starred?'starred':''}" aria-label="${m.starred?'Unstar':'Star'} message">${m.starred?'★':'☆'}</button>`;
    row.addEventListener('click',e=>{
      if(e.target.closest('.star-btn')){e.stopPropagation();m.starred=!m.starred;api('/api/flags',{folder:activeFolder,uids:[m.id],op:m.starred?'star':'unstar'}).catch(netErr);renderList();return}
      if(e.target.classList.contains('message-check')){e.stopPropagation();if(e.target.checked)selectedRows.add(m.id);else selectedRows.delete(m.id);updateBulk();return}
      if(selectionMode){const cb=row.querySelector('.message-check');cb.checked=!cb.checked;if(cb.checked)selectedRows.add(m.id);else selectedRows.delete(m.id);updateBulk();return}
      openMessage(m.id);
    });
    row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openMessage(m.id)}});
    messageList.appendChild(row);
  });
  updateBulk();
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function bodyHtml(m){
  if(m.body==='welcome')return `<img class="hero-logo" src="assets/infiniti-logo.jpeg" alt="infiniti Code Technologies logo"><p>Hi,</p><p>Welcome to your new Infiniti Mail account. We're excited to have you on board!</p><p>Here are a few things you can do to get started:</p><ul><li>Send and receive emails</li><li>Manage your calendar</li><li>Stay connected with your team</li><li>Access your work apps</li></ul><p>If you have any questions, feel free to reach out to our support team.</p><div class="email-signoff">Best regards,<br>Infiniti Code Technologies Private Limited<br><span class="signature">Build · Innovate · Grow</span></div>`;
  const content={
    security:`<p>We noticed a new sign-in to your Google Account.</p><p><strong>Device:</strong> Mac<br><strong>Time:</strong> Today, 9:42 AM</p><p>If this was you, no action is needed. If you don't recognize this activity, review your account security settings.</p><p>Thanks,<br>The account security team</p>`,
    project:`<p>Hello,</p><p>Please find the latest design files for the website project. The updated assets and layout notes are ready for review.</p><p>Let us know if you have any feedback or changes.</p><p>Regards,<br>Project Updates</p>`,
    meeting:`<p>Hi Team,</p><p>Don't forget about the meeting scheduled for tomorrow at <strong>10:00 AM</strong>.</p><p>Agenda:</p><ul><li>Project progress</li><li>Upcoming milestones</li><li>Open questions</li></ul><p>See you there!</p>`,
    hr:`<p>Hello,</p><p>Please complete the attached onboarding documents for your employee records. Contact the HR team if you have questions or need help.</p><p>Best regards,<br>HR Department</p>`,
    support:`<p>Hello,</p><p>Thank you for reaching out about your project inquiry. We have received your message and will get back to you shortly.</p><p>Kind regards,<br>Client Support</p>`,
    microsoft:`<p>Hello,</p><p>Here is your security information about your Microsoft account. Please review your account settings if any of these details look unfamiliar.</p><p>Thanks,<br>Microsoft account team</p>`
  };
  return content[m.body]||`<p>${escapeHtml(m.snippet)}</p><p>Regards,<br>${escapeHtml(m.sender)}</p>`;
}
async function openMessage(id){
  const m=messages.find(x=>x.id===id);if(!m)return;selectedId=id;
  $('readingEmpty').classList.add('hidden');$('emailView').classList.remove('hidden');$('readingPanel').classList.add('mobile-open');$('workspace').classList.remove('reading-closed');
  $('emailSubject').textContent=m.subject;$('emailLabel').textContent=m.label||'Inbox';$('emailAvatar').textContent=m.initials;$('emailAvatar').className='avatar '+m.color;
  $('emailSender').textContent=m.sender;$('emailAddress').textContent=m.address;$('emailTime').textContent=timeLabel(m);$('emailBody').textContent='Loading…';
  const wasUnread=m.unread;m.unread=false;renderList();
  try{
    const d=await api('/api/message?'+new URLSearchParams({folder:activeFolder,uid:id}));
    if(selectedId!==id)return;
    Object.assign(m,{messageId:d.message_id,references:d.references,replyTo:d.reply_to||m.address,body_text:d.text});
    renderBody(d,id);if(wasUnread)refreshCounts();
  }catch(e){if(selectedId===id)$('emailBody').textContent='Could not load this message.'}
}
function updateBulk(){const n=pageIds.filter(id=>selectedRows.has(id)).length,box=$('selectAllBox');box.checked=n>0&&n===pageIds.length;box.indeterminate=n>0&&n<pageIds.length;$('bulkToolbar').classList.toggle('hidden',!selectionMode);$('selectedCount').textContent=`${selectedRows.size} selected`;document.querySelectorAll('.message-row').forEach(r=>r.classList.toggle('selection-mode',selectionMode))}
async function selectAction(action){
  const ids=selectedRows.size?[...selectedRows]:visibleMessages().map(m=>m.id);
  if(!ids.length){toast('No messages to update');return}
  try{
    if(action==='delete')await api('/api/delete',{folder:activeFolder,uids:ids});
    else if(action==='archive')await api('/api/move',{folder:activeFolder,uids:ids,to:'Archived'});
    else await api('/api/flags',{folder:activeFolder,uids:ids,op:'seen'});
  }catch(e){return netErr(e)}
  ids.forEach(id=>{const m=messages.find(x=>x.id===id);if(!m)return;if(action==='delete')m.label='Trash';if(action==='archive')m.label='Archived';if(action==='read')m.unread=false});
  selectedRows.clear();selectionMode=false;renderList();refreshCounts();toast(action==='delete'?'Message(s) moved to Trash':action==='archive'?'Message(s) archived':'Marked as read');
}
$('searchInput').addEventListener('input',renderList);
document.querySelectorAll('[data-folder]').forEach(btn=>btn.addEventListener('click',()=>{activeFolder=btn.dataset.folder;currentLabel='';document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x===btn));renderList()}));
document.querySelectorAll('[data-label]').forEach(btn=>btn.addEventListener('click',()=>{currentLabel=btn.dataset.label;activeFolder='Inbox';document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));renderList()}));
$('moreBtn').addEventListener('click',()=>{$('moreFolders').classList.toggle('hidden');$('moreBtn').querySelector('.nav-chevron').textContent=$('moreFolders').classList.contains('hidden')?'›':'⌄'});
$('composeBtn').addEventListener('click',()=>{composeMeta={};$('composeStatus').textContent='';$('composeDialog').showModal()});
$('composeForm').addEventListener('submit',async e=>{
  e.preventDefault();const to=$('composeTo').value.trim();if(!to){toast('Enter a recipient email address');return}
  const btn=$('sendBtn');btn.disabled=true;$('composeStatus').textContent='Sending…';
  try{
    await api('/api/send',{to,subject:$('composeSubject').value.trim(),body:$('composeBody').value,...composeMeta});
    $('composeDialog').close();$('composeForm').reset();composeMeta={};toast('Message sent');
    if(activeFolder==='Sent')loadFolder();refreshCounts();
  }catch(err){$('composeStatus').textContent=err.message||'Send failed'}finally{btn.disabled=false}
});
$('archiveBtn').addEventListener('click',()=>selectAction('archive'));$('deleteBtn').addEventListener('click',()=>selectAction('delete'));$('markReadBtn').addEventListener('click',()=>selectAction('read'));
function setMax(on){$('workspace').classList.toggle('reading-maximized',on);const b=$('maximizeReading');b.setAttribute('aria-pressed',String(on));b.title=b.ariaLabel=on?'Restore message':'Maximize message'}
$('maximizeReading').addEventListener('click',()=>setMax(!$('workspace').classList.contains('reading-maximized')));
document.querySelectorAll('[data-folder],[data-label]').forEach(b=>b.addEventListener('click',()=>setMax(false)));
$('searchInput').addEventListener('input',()=>setMax(false));
function closeReading(){setMax(false);selectedId=null;$('readingPanel').classList.remove('mobile-open');$('workspace').classList.add('reading-closed');$('emailView').classList.add('hidden');$('readingEmpty').classList.remove('hidden');renderList()}
$('closeReading').addEventListener('click',closeReading);
function reply(forward=false){
  const m=messages.find(x=>x.id===selectedId);if(!m){toast('Select a message first');return}
  const quoted=(m.body_text||m.snippet||'').split('\n').slice(0,60).map(l=>'> '+l).join('\n');
  $('composeStatus').textContent='';$('composeTo').value=forward?'':(m.replyTo||m.address);
  $('composeSubject').value=(forward?'Fwd: ':(/^re:/i.test(m.subject)?'':'Re: '))+m.subject;
  composeMeta=forward?{}:{in_reply_to:m.messageId||'',references:m.references||''};
  $('composeBody').value=forward?`\n\n---------- Forwarded message ----------\nFrom: ${m.sender} <${m.address}>\nSubject: ${m.subject}\n\n${m.body_text||m.snippet}`:`\n\nOn ${new Date(m.ts*1000).toLocaleString('en-IN')}, ${m.sender} wrote:\n${quoted}`;
  $('composeDialog').showModal();
}
$('replyBtn').addEventListener('click',()=>reply(false));$('replyArrow').addEventListener('click',()=>reply(false));$('forwardBtn').addEventListener('click',()=>reply(true));
$('reactBtn').addEventListener('click',()=>toast('Reaction added 🙂'));
$('emailMenu').addEventListener('click',()=>toast('More message actions are ready to connect'));
$('settingsBtn').addEventListener('click',()=>toast('Settings panel demo — add your preferences here'));
$('notificationsBtn').addEventListener('click',()=>toast('You are all caught up!'));
function setProfileMenu(open){if(open)closeMenus();$('profileMenu').classList.toggle('hidden',!open);$('profileBtn').setAttribute('aria-expanded',String(open))}
$('pmLastLogin').textContent='Today, '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
$('profileBtn').addEventListener('click',e=>{e.stopPropagation();setProfileMenu($('profileMenu').classList.contains('hidden'))});
$('profileMenu').addEventListener('click',e=>e.stopPropagation());
document.addEventListener('click',()=>setProfileMenu(false));
$('pmCopy').addEventListener('click',()=>{const t=ME.email;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>toast('Email copied'),()=>toast(t))});
$('pmManage').addEventListener('click',()=>{setProfileMenu(false);toast('Account settings demo — connect your account service')});
$('pmSignOut').addEventListener('click',async()=>{setProfileMenu(false);try{await api('/api/logout',{})}catch(e){}location.reload()});
$('addLabelBtn').addEventListener('click',()=>{const label=prompt('Enter a label name:');if(!label||!label.trim())return;const b=document.createElement('button');b.className='label-item';b.innerHTML=`<i class="label-dot work"></i>${escapeHtml(label.trim())}`;b.addEventListener('click',()=>{currentLabel=label.trim();renderList()});$('addLabelBtn').parentElement.insertAdjacentElement('afterend',b);toast(`Label "${label.trim()}" added`)});
const appDock=$('appDock'),appsBtn=$('appsBtn');
function setDock(collapsed,save=true){
  appDock.classList.toggle('collapsed',collapsed);
  appsBtn.setAttribute('aria-expanded',String(!collapsed));
  appsBtn.title=collapsed?'Maximize apps':'Minimize apps';
  if(save){try{localStorage.setItem('appsDockCollapsed',collapsed?'1':'0')}catch(e){}}
}
try{setDock(localStorage.getItem('appsDockCollapsed')==='1',false)}catch(e){}
appsBtn.addEventListener('click',()=>setDock(!appDock.classList.contains('collapsed')));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&closeMenus())return;if(e.key==='Escape'&&!$('profileMenu').classList.contains('hidden')){setProfileMenu(false);return}if(e.key==='Escape'&&!$('composeDialog').open&&!$('appDialog').open&&selectedId!==null)closeReading();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('searchInput').focus()}if(e.key==='Enter'&&document.activeElement===$('searchInput'))renderList()});
renderList();

/* ===== Apps dock: dialogs with sample data ===== */
const dayOffset=n=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+n);return d};
const fmtDate=d=>d.toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
const appData={
  events:[
    {d:1,time:'10:00 AM',title:'Product Launch Webinar',place:'Online · Zoom'},
    {d:3,time:'02:00 PM',title:'Client Demo — Website Project',place:'Conference Room A'},
    {d:5,time:'11:30 AM',title:'Team Outing',place:'Cubbon Park, Bengaluru'},
    {d:9,time:'09:30 AM',title:'Quarterly Review',place:'Boardroom'},
    {d:14,time:'04:00 PM',title:'Tech Meetup',place:'Infiniti Code Office'}
  ],
  contacts:[
    {name:'Ananya Rao',role:'UI/UX Designer',email:'ananya@infiniticodetech.com',color:'pink'},
    {name:'Client Support',role:'Support Desk',email:'support@infiniticodetech.com',color:'blue'},
    {name:'HR Department',role:'Human Resources',email:'hr@infiniticodetech.com',color:''},
    {name:'Infiniti Team',role:'Official Team Account',email:'hello@infiniticodetech.com',color:''},
    {name:'Rahul Verma',role:'Full-Stack Developer',email:'rahul@infiniticodetech.com',color:'green'},
    {name:'Sneha Reddy',role:'Project Manager',email:'sneha@infiniticodetech.com',color:'blue'}
  ],
  meetings:[
    {d:0,time:'10:00 AM',title:'Daily Stand-up',people:'Dev Team · 8 people'},
    {d:0,time:'12:30 PM',title:'Design Review',people:'Ananya, Sneha, Rahul'},
    {d:0,time:'03:00 PM',title:'Client Sync — Project Inquiry',people:'Client Support, Sneha'},
    {d:1,time:'10:00 AM',title:'Sprint Planning',people:'Entire Team'},
    {d:4,time:'11:00 AM',title:'HR Onboarding Session',people:'HR Department'}
  ],
  tasks:[
    {text:'Review website design files',done:true},
    {text:'Complete onboarding documents',done:false},
    {text:'Reply to client project inquiry',done:false},
    {text:'Prepare agenda for tomorrow\'s meeting',done:false},
    {text:'Update project roadmap',done:false}
  ]
};
const cal={y:new Date().getFullYear(),m:new Date().getMonth(),sel:dayOffset(0)};
const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
function calendarItems(){return [...appData.events.map(e=>({date:dayOffset(e.d),time:e.time,title:e.title,type:'Event'})),...appData.meetings.map(e=>({date:dayOffset(e.d),time:e.time,title:e.title,type:'Meeting'}))]}
const appViews={
  Events(){
    return `<p class="app-sub">Upcoming events</p><ul class="app-list">${appData.events.map(e=>`<li class="app-item"><div class="date-chip"><b>${dayOffset(e.d).getDate()}</b><span>${dayOffset(e.d).toLocaleDateString('en-IN',{month:'short'})}</span></div><div class="app-item-main"><strong>${escapeHtml(e.title)}</strong><span>${fmtDate(dayOffset(e.d))} · ${escapeHtml(e.time)}</span><small>${escapeHtml(e.place)}</small></div></li>`).join('')}</ul>`;
  },
  Contacts(){
    return `<input class="app-search" id="contactSearch" type="search" placeholder="Search contacts..." autocomplete="off"><ul class="app-list" id="contactList"></ul>`;
  },
  Meetings(){
    return `<p class="app-sub">Today &amp; upcoming meetings</p><ul class="app-list">${appData.meetings.map(m=>`<li class="app-item"><div class="date-chip"><b>${m.d===0?'Today':dayOffset(m.d).getDate()}</b><span>${m.d===0?'':dayOffset(m.d).toLocaleDateString('en-IN',{month:'short'})}</span></div><div class="app-item-main"><strong>${escapeHtml(m.title)}</strong><span>${fmtDate(dayOffset(m.d))} · ${escapeHtml(m.time)}</span><small>${escapeHtml(m.people)}</small></div><button class="outline-btn" data-join="${escapeHtml(m.title)}">Join</button></li>`).join('')}</ul>`;
  },
  Calendar(){return `<div id="calendarView"></div>`},
  Tasks(){return `<div id="tasksView"></div>`}
};
function renderContacts(){
  const q=($('contactSearch')?.value||'').trim().toLowerCase();
  const list=appData.contacts.filter(c=>[c.name,c.role,c.email].join(' ').toLowerCase().includes(q));
  $('contactList').innerHTML=list.length?list.map(c=>`<li class="app-item"><div class="avatar ${c.color}">${escapeHtml(c.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase())}</div><div class="app-item-main"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.role)}</span><small>${escapeHtml(c.email)}</small></div><button class="outline-btn" data-mail="${escapeHtml(c.email)}">Email</button></li>`).join(''):'<li class="app-empty">No contacts found</li>';
}
function renderCalendar(){
  const first=new Date(cal.y,cal.m,1),days=new Date(cal.y,cal.m+1,0).getDate(),items=calendarItems(),today=new Date();
  let cells=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<span class="cal-dow">${d}</span>`).join('');
  for(let i=0;i<first.getDay();i++)cells+='<span></span>';
  for(let d=1;d<=days;d++){
    const date=new Date(cal.y,cal.m,d),has=items.some(i=>sameDay(i.date,date));
    cells+=`<button class="cal-day${sameDay(date,today)?' today':''}${sameDay(date,cal.sel)?' sel':''}${has?' has':''}" data-day="${d}">${d}</button>`;
  }
  const agenda=items.filter(i=>sameDay(i.date,cal.sel));
  $('calendarView').innerHTML=`<div class="cal-head"><button class="icon-button" data-cal="-1" aria-label="Previous month">‹</button><strong>${first.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</strong><button class="icon-button" data-cal="1" aria-label="Next month">›</button></div><div class="cal-grid">${cells}</div><p class="app-sub">${fmtDate(cal.sel)}</p><ul class="app-list">${agenda.length?agenda.map(i=>`<li class="app-item"><div class="app-item-main"><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.time)} · ${i.type}</span></div></li>`).join(''):'<li class="app-empty">Nothing scheduled</li>'}</ul>`;
}
function renderTasks(){
  const done=appData.tasks.filter(t=>t.done).length,total=appData.tasks.length;
  $('tasksView').innerHTML=`<form class="task-add" id="taskForm"><input id="taskInput" placeholder="Add a new task..." autocomplete="off" required><button class="primary-btn" type="submit">Add</button></form><p class="app-sub">${done} of ${total} completed</p><div class="task-progress"><i style="width:${total?Math.round(done/total*100):0}%"></i></div><ul class="app-list">${appData.tasks.map((t,i)=>`<li class="app-item task${t.done?' done':''}"><label><input type="checkbox" data-task="${i}" ${t.done?'checked':''}><span>${escapeHtml(t.text)}</span></label><button class="icon-button" data-deltask="${i}" aria-label="Delete task">×</button></li>`).join('')||'<li class="app-empty">No tasks yet</li>'}</ul>`;
}
function openApp(name){
  const btn=document.querySelector(`[data-app="${name}"]`);
  document.querySelectorAll('[data-app]').forEach(x=>x.classList.toggle('active',x===btn));
  $('appDialogTitle').textContent=name;$('appDialogIcon').textContent=btn.querySelector('.dock-icon').textContent;
  $('appDialogBody').innerHTML=appViews[name]();
  if(name==='Contacts')renderContacts();
  if(name==='Calendar')renderCalendar();
  if(name==='Tasks')renderTasks();
  $('appDialogBody').scrollTop=0;
  if(!$('appDialog').open)$('appDialog').showModal();
}
document.querySelectorAll('[data-app]').forEach(btn=>btn.addEventListener('click',()=>openApp(btn.dataset.app)));
$('appDialogClose').addEventListener('click',()=>$('appDialog').close());
$('appDialog').addEventListener('click',e=>{if(e.target===$('appDialog'))$('appDialog').close()});
$('appDialog').addEventListener('close',()=>document.querySelectorAll('[data-app]').forEach(x=>x.classList.remove('active')));
$('appDialogBody').addEventListener('input',e=>{if(e.target.id==='contactSearch')renderContacts()});
$('appDialogBody').addEventListener('click',e=>{
  const t=e.target;
  if(t.dataset.mail){$('appDialog').close();$('composeStatus').textContent='';$('composeForm').reset();$('composeTo').value=t.dataset.mail;$('composeDialog').showModal();return}
  if(t.dataset.join){toast(`Joining "${t.dataset.join}" (demo)`);return}
  if(t.dataset.cal){cal.m+=Number(t.dataset.cal);if(cal.m<0){cal.m=11;cal.y--}if(cal.m>11){cal.m=0;cal.y++}renderCalendar();return}
  if(t.dataset.day){cal.sel=new Date(cal.y,cal.m,Number(t.dataset.day));renderCalendar();return}
  if(t.dataset.deltask!==undefined){appData.tasks.splice(Number(t.dataset.deltask),1);renderTasks();return}
});
$('appDialogBody').addEventListener('change',e=>{if(e.target.dataset.task!==undefined){appData.tasks[Number(e.target.dataset.task)].done=e.target.checked;renderTasks()}});
$('appDialogBody').addEventListener('submit',e=>{if(e.target.id==='taskForm'){e.preventDefault();const v=$('taskInput').value.trim();if(v){appData.tasks.unshift({text:v,done:false});renderTasks();$('taskInput').focus()}}});

/* ===== List toolbar: menus, selection, filter, paging ===== */
const tbMenus=[['selectMenu','selectMenuBtn'],['moreMenu','moreActionsBtn'],['filterMenu','filterBtn']];
function closeMenus(){let was=false;tbMenus.forEach(([m,b])=>{if(!$(m).classList.contains('hidden'))was=true;$(m).classList.add('hidden');$(b).setAttribute('aria-expanded','false')});return was}
tbMenus.forEach(([m,b])=>$(b).addEventListener('click',e=>{e.stopPropagation();const open=$(m).classList.contains('hidden');closeMenus();setProfileMenu(false);if(open){$(m).classList.remove('hidden');$(b).setAttribute('aria-expanded','true')}}));
document.addEventListener('click',closeMenus);
function selectBy(kind){
  const pick={all:()=>true,none:()=>false,read:m=>!m.unread,unread:m=>m.unread,starred:m=>m.starred,unstarred:m=>!m.starred}[kind];
  selectedRows.clear();messages.filter(m=>pageIds.includes(m.id)&&pick(m)).forEach(m=>selectedRows.add(m.id));
  selectionMode=selectedRows.size>0;renderList();
  if(!selectionMode&&kind!=='none')toast('No matching messages');
}
$('selectAllBox').addEventListener('change',e=>selectBy(e.target.checked?'all':'none'));
document.querySelectorAll('[data-select]').forEach(b=>b.addEventListener('click',()=>selectBy(b.dataset.select)));
$('refreshBtn').addEventListener('click',()=>{const b=$('refreshBtn');b.classList.remove('spin');void b.offsetWidth;b.classList.add('spin');loadFolder().then(()=>{refreshCounts();toast('Mailbox refreshed')})});
$('markAllReadBtn').addEventListener('click',async()=>{
  const list=visibleMessages(),un=list.filter(m=>m.unread),n=un.length;
  if(n){try{await api('/api/flags',{folder:activeFolder,uids:un.map(m=>m.id),op:'seen'})}catch(e){return netErr(e)}}
  list.forEach(m=>m.unread=false);renderList();refreshCounts();toast(n?`${n} message${n>1?'s':''} marked as read`:'All messages are already read');
});
function syncFilterMenu(){
  document.querySelectorAll('[data-datefilter]').forEach(b=>b.classList.toggle('on',b.dataset.datefilter===dateFilter.type));
  $('customRange').classList.toggle('hidden',dateFilter.type!=='custom');
  $('dateFrom').value=dateFilter.from;$('dateTo').value=dateFilter.to;
  $('dateFrom').max=dateFilter.to||'';$('dateTo').min=dateFilter.from||'';
  $('filterBtn').classList.toggle('active',readFilter!=='all'||sortOrder!=='newest'||dateFilter.type!=='all');
}
syncFilterMenu();
$('prevPage').addEventListener('click',()=>{if(page>0){page--;selectedRows.clear();selectionMode=false;renderList();messageList.scrollTop=0}});
$('nextPage').addEventListener('click',()=>{page++;selectedRows.clear();selectionMode=false;renderList();messageList.scrollTop=0});

/* ===== Delete icon + date filters ===== */
async function deleteSelected(){
  let ids=[...selectedRows];
  if(!ids.length&&selectedId!==null)ids=[selectedId];
  if(!ids.length){toast('Select messages to delete');return}
  const permanent=activeFolder==='Trash';
  if(permanent&&!confirm(`Permanently delete ${ids.length} message${ids.length>1?'s':''}? This cannot be undone.`))return;
  try{await api('/api/delete',{folder:activeFolder,uids:ids})}catch(e){return netErr(e)}
  ids.forEach(id=>{const i=messages.findIndex(x=>x.id===id);if(i<0)return;if(permanent)messages.splice(i,1);else messages[i].label='Trash'});
  const wasOpen=ids.includes(selectedId);
  selectedRows.clear();selectionMode=false;
  if(wasOpen)closeReading();else renderList();refreshCounts();
  toast(permanent?'Message(s) deleted permanently':'Message(s) moved to Trash');
}
$('deleteSelBtn').addEventListener('click',deleteSelected);
document.querySelectorAll('[data-datefilter]').forEach(b=>b.addEventListener('click',e=>{
  const t=b.dataset.datefilter;
  if(t==='custom')e.stopPropagation();
  dateFilter.type=t;
  if(t!=='custom'){dateFilter.from='';dateFilter.to=''}
  syncFilterMenu();renderList();
}));
$('customRange').addEventListener('click',e=>e.stopPropagation());
['dateFrom','dateTo'].forEach(id=>$(id).addEventListener('change',()=>{dateFilter.from=$('dateFrom').value;dateFilter.to=$('dateTo').value;syncFilterMenu();renderList()}));
$('rangeClear').addEventListener('click',()=>{dateFilter={type:'all',from:'',to:''};syncFilterMenu();renderList()});


/* ===== Backend connection (Flask API) ===== */
let ME={email:'',name:'',admin:false},loadedFolder=null,loadSeq=0;
const netErr=e=>toast((e&&e.message)||'Something went wrong');
async function api(url,body){
  const opt=body===undefined?{credentials:'same-origin'}:{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
  const r=await fetch(url,opt);let d={};try{d=await r.json()}catch(e){}
  if(r.status===401&&url!=='/api/login'){showLogin();throw new Error('Please sign in')}
  if(!r.ok)throw new Error(d.error||'Request failed');return d;
}
const AV=['','blue','pink','gray','green'];
function mapMsg(x,folder){
  const name=x.name||x.address||'(unknown)',d=new Date(x.ts*1000);
  const ini=name.replace(/^To: /,'').split(/[\s@.]+/).filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'?';
  const a=Math.max(0,Math.round((dayStart(0)-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/864e5));
  let h=0;for(const ch of name)h=(h*31+ch.charCodeAt(0))>>>0;
  return {id:x.id,initials:ini,sender:name,address:x.address,subject:x.subject,snippet:x.snippet,ts:x.ts,date:x.ts,daysAgo:a,label:folder,unread:x.unread,starred:x.starred,color:AV[h%AV.length],time:d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})};
}
async function loadFolder(){
  const folder=activeFolder,seq=++loadSeq;
  try{
    const d=await api('/api/messages?'+new URLSearchParams({folder}));
    if(seq!==loadSeq)return;
    messages=d.messages.map(x=>mapMsg(x,folder));loadedFolder=folder;renderList();
  }catch(e){if(seq===loadSeq)netErr(e)}
}
function renderBody(d,id){
  const box=$('emailBody');box.textContent='';
  if(d.html){
    const f=document.createElement('iframe');f.className='mail-frame';
    f.setAttribute('sandbox','allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    f.srcdoc='<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>body{font:14px/1.5 Arial,sans-serif;color:#222;margin:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>'+d.html;
    f.addEventListener('load',()=>{try{f.style.height=(f.contentDocument.documentElement.scrollHeight+8)+'px'}catch(e){}});
    box.appendChild(f);
  }else{const t=document.createElement('div');t.className='mail-text';t.textContent=d.text||'(no content)';box.appendChild(t)}
  if(d.attachments&&d.attachments.length){
    const w=document.createElement('div');w.className='mail-attachments';
    d.attachments.forEach(a=>{const l=document.createElement('a');l.className='attach-chip';l.href='/api/attachment?'+new URLSearchParams({folder:activeFolder,uid:id,idx:a.idx});l.textContent='📎 '+a.name+' ('+fmtSize(a.size)+')';w.appendChild(l)});
    box.appendChild(w);
  }
}
const fmtSize=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
function setCount(f,n){const b=document.querySelector(`[data-folder="${f}"]`);let c=b.querySelector('.count');if(!n){if(c)c.remove();return}if(!c){c=document.createElement('b');c.className='count';b.appendChild(c)}c.textContent=n}
async function refreshCounts(){
  try{
    const d=await api('/api/folders');setCount('Inbox',d.inbox_unread);setCount('Drafts',d.drafts);setCount('Starred',0);
    const st=document.querySelector('.storage');
    if(d.quota&&d.quota.limit_kb){
      const pct=Math.min(100,Math.round(d.quota.used_kb/d.quota.limit_kb*100)),g=kb=>kb>=1048576?(kb/1048576).toFixed(1)+' GB':Math.round(kb/1024)+' MB';
      st.querySelector('div span:last-child').textContent=pct+'%';st.querySelector('.storage-track i').style.width=pct+'%';
      st.querySelector('small').textContent=g(d.quota.used_kb)+' of '+g(d.quota.limit_kb)+' used';st.hidden=false;
    }else st.hidden=true;
  }catch(e){}
}
function showLogin(){$('loginScreen').classList.remove('hidden');document.body.classList.add('locked');setTimeout(()=>$('loginEmail').focus(),50)}
function applyMe(me){
  ME=me;const ini=me.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase()||'U';
  document.querySelector('.profile span').textContent=ini;document.querySelector('.pm-avatar').textContent=ini;
  document.querySelector('.pm-id strong').textContent=me.name;document.querySelector('.pm-id span').textContent=me.email;
  const dd=document.querySelectorAll('.pm-details dd');dd[0].textContent=me.email;dd[3].textContent=me.admin?'Administrator':'Member';
  document.querySelector('.admin-badge').classList.toggle('hidden',!me.admin);
  $('pmLastLogin').textContent=new Date(me.last_login*1000).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
}
async function startSession(me){
  applyMe(me||await api('/api/me'));$('loginScreen').classList.add('hidden');document.body.classList.remove('locked');
  activeFolder='Inbox';currentLabel='';document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.folder==='Inbox'));
  await loadFolder();refreshCounts();
}
document.querySelectorAll('[data-folder]').forEach(b=>b.addEventListener('click',loadFolder));
document.querySelectorAll('[data-label]').forEach(b=>b.addEventListener('click',()=>{if(loadedFolder!=='Inbox')loadFolder()}));
$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const b=$('loginBtn');b.disabled=true;$('loginError').textContent='';
  try{await api('/api/login',{email:$('loginEmail').value.trim(),password:$('loginPassword').value});$('loginPassword').value='';await startSession()}
  catch(err){$('loginError').textContent=err.message}finally{b.disabled=false}
});
api('/api/me').then(startSession).catch(showLogin);
setInterval(()=>{if(!document.hidden&&ME.email&&$('loginScreen').classList.contains('hidden')){loadFolder();refreshCounts()}},120000);
