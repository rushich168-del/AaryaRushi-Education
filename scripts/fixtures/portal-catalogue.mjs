export const catalogue={
 categories:[{id:'school',name:'School & Military Entrance',is_active:true},{id:'engineering',name:'Engineering & Medical Entrance',is_active:true},{id:'government',name:'Government Exams',is_active:true}],
 exams:[{id:'sainik',name:'Sainik',category_id:'school'},{id:'eamcet',name:'EAMCET',category_id:'engineering'},{id:'dsc',name:'DSC',category_id:'government'}],
 levels:[{id:'six',exam_id:'sainik',name:'Class VI'},{id:'nine',exam_id:'sainik',name:'Class IX'},{id:'engineering-track',exam_id:'eamcet',name:'Engineering'},{id:'agriculture',exam_id:'eamcet',name:'Agriculture/Pharmacy'}],
 subjects:[{id:'math',exam_id:'sainik',name:'Mathematics'}],
 syllabi:[{id:'syllabus',exam_id:'sainik',level_id:'six',subject_id:'math',name:'Class VI curriculum',status:'ACTIVE'}],
 chapters:[{id:'chapter',syllabus_id:'syllabus',name:'Fractions'}],topics:[{id:'topic',chapter_id:'chapter',name:'Comparing fractions'}],
}
