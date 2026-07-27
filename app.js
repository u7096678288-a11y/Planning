const applications = [
  {ref:'LRD6024/25-S3',name:'Riverside Quarter',applicant:'Bartra Property Ltd',location:'Clonburris, Dublin 22',county:'Dublin',units:578,status:'Under review',date:'18 Sep 2026'},
  {ref:'LRD0032/25',name:'Marina Village Phase 2',applicant:'Glenveagh Homes',location:'Passage West, Co. Cork',county:'Cork',units:424,status:'Granted',date:'04 Jul 2026'},
  {ref:'LRD2025/014',name:'Parkside Residential',applicant:'Cairn Homes Properties',location:'Swords, Co. Dublin',county:'Dublin',units:381,status:'Granted',date:'28 Jun 2026'},
  {ref:'LRD.24.06',name:'Crown Square Residential',applicant:'JJ Rhatigan & Company',location:'Mervue, Galway City',county:'Galway',units:345,status:'Further information',date:'12 Oct 2026'},
  {ref:'LRD2025/08',name:'Oakwood Avenue',applicant:'Ardstone Homes',location:'Naas, Co. Kildare',county:'Kildare',units:302,status:'Under review',date:'02 Nov 2026'},
  {ref:'LRD0018/24',name:'Boyne View',applicant:'McGarrell Reilly',location:'Navan, Co. Meath',county:'Meath',units:274,status:'Granted',date:'16 May 2026'}
];
const rows=document.querySelector('#applicationRows'), empty=document.querySelector('#emptyState');
const statusClass=s=>s==='Under review'?'review':s==='Further information'?'info':'';
function render(){
  const q=document.querySelector('#tableSearch').value.toLowerCase().trim();
  const status=document.querySelector('#statusFilter').value, county=document.querySelector('#countyFilter').value;
  const data=applications.filter(a=>(status==='all'||a.status===status)&&(county==='all'||a.county===county)&&Object.values(a).join(' ').toLowerCase().includes(q));
  rows.innerHTML=data.map((a,i)=>`<tr><td><span class="ref">${a.ref}</span></td><td><strong>${a.name}</strong><small>${a.applicant}</small></td><td><strong>${a.location}</strong><small>${a.county} County Council</small></td><td class="units">${a.units}</td><td><span class="status ${statusClass(a.status)}">${a.status}</span></td><td><strong>${a.date}</strong></td><td><button class="row-action" data-index="${applications.indexOf(a)}" aria-label="View ${a.name}">•••</button></td></tr>`).join('');
  empty.hidden=data.length>0; document.querySelector('#rangeText').textContent=data.length?`1–${data.length}`:'0';
  document.querySelector('#totalText').textContent=(q||status!=='all'||county!=='all')?data.length:'247';
  document.querySelector('#resultCount').textContent=(q||status!=='all'||county!=='all')?data.length:'247';
}
['tableSearch','statusFilter','countyFilter'].forEach(id=>document.querySelector('#'+id).addEventListener('input',render));
document.querySelector('#search').addEventListener('input',e=>{document.querySelector('#tableSearch').value=e.target.value;render();document.querySelector('#applications').scrollIntoView({behavior:'smooth'})});
document.querySelector('#clearFilters').addEventListener('click',()=>{document.querySelector('#tableSearch').value='';document.querySelector('#statusFilter').value='all';document.querySelector('#countyFilter').value='all';render()});
const dialog=document.querySelector('#detailDialog');
rows.addEventListener('click',e=>{const btn=e.target.closest('.row-action');if(!btn)return;const a=applications[btn.dataset.index];document.querySelector('#dialogTitle').textContent=a.name;document.querySelector('#dialogBody').innerHTML=`<div class="detail-grid"><div><small>REFERENCE</small><strong>${a.ref}</strong></div><div><small>STATUS</small><span class="status ${statusClass(a.status)}">${a.status}</span></div><div><small>APPLICANT</small><strong>${a.applicant}</strong></div><div><small>PROPOSED UNITS</small><strong>${a.units}</strong></div><div><small>LOCATION</small><strong>${a.location}</strong></div><div><small>DECISION DATE</small><strong>${a.date}</strong></div></div>`;dialog.showModal()});
document.querySelector('.dialog-close').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
function toast(message){const t=document.querySelector('#toast');t.textContent=message;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
document.querySelector('#refreshBtn').onclick=e=>{e.currentTarget.animate([{transform:'rotate(0)'},{transform:'rotate(360deg)'}],{duration:600});toast('Database is up to date')};
document.querySelector('#exportBtn').onclick=()=>{const header='Reference,Development,Applicant,Location,County,Units,Status,Decision date\n';const csv=header+applications.map(a=>Object.values(a).map(v=>`"${v}"`).join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='lrd-applications.csv';a.click();URL.revokeObjectURL(a.href);toast('Export downloaded')};
document.querySelector('#moreFilters').onclick=()=>toast('Additional filters are ready to configure');
render();
