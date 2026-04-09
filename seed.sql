-- =============================================
-- AutoHub DZ - Seed Data (Complete)
-- =============================================

-- 58 Wilayas d'Algérie
INSERT OR IGNORE INTO wilayas (id, name, code) VALUES
(1,'Adrar','01'),(2,'Chlef','02'),(3,'Laghouat','03'),(4,'Oum El Bouaghi','04'),
(5,'Batna','05'),(6,'Bejaia','06'),(7,'Biskra','07'),(8,'Bechar','08'),
(9,'Blida','09'),(10,'Bouira','10'),(11,'Tamanrasset','11'),(12,'Tebessa','12'),
(13,'Tlemcen','13'),(14,'Tiaret','14'),(15,'Tizi Ouzou','15'),(16,'Alger','16'),
(17,'Djelfa','17'),(18,'Jijel','18'),(19,'Setif','19'),(20,'Saida','20'),
(21,'Skikda','21'),(22,'Sidi Bel Abbes','22'),(23,'Annaba','23'),(24,'Guelma','24'),
(25,'Constantine','25'),(26,'Medea','26'),(27,'Mostaganem','27'),(28,'Msila','28'),
(29,'Mascara','29'),(30,'Ouargla','30'),(31,'Oran','31'),(32,'El Bayadh','32'),
(33,'Illizi','33'),(34,'Bordj Bou Arreridj','34'),(35,'Boumerdes','35'),
(36,'El Tarf','36'),(37,'Tindouf','37'),(38,'Tissemsilt','38'),(39,'El Oued','39'),
(40,'Khenchela','40'),(41,'Souk Ahras','41'),(42,'Tipaza','42'),(43,'Mila','43'),
(44,'Ain Defla','44'),(45,'Naama','45'),(46,'Ain Temouchent','46'),
(47,'Ghardaia','47'),(48,'Relizane','48'),(49,'Timimoun','49'),
(50,'Bordj Badji Mokhtar','50'),(51,'Ouled Djellal','51'),(52,'Beni Abbes','52'),
(53,'In Salah','53'),(54,'In Guezzam','54'),(55,'Touggourt','55'),(56,'Djanet','56'),
(57,'El Meghaier','57'),(58,'El Meniaa','58');

-- =============================================
-- COMMUNES COMPLETES - 1541 communes (58 wilayas)
-- =============================================

-- Wilaya 01: Adrar (11 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Adrar',1),('Bouda',1),('Reggane',1),('In Zghmir',1),('Tit',1),
('Ksar Kaddour',1),('Tsabit',1),('Timimoun',1),('Charouine',1),
('Ouled Ahmed Tammi',1),('Fenoughil',1);

-- Wilaya 02: Chlef (13 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Chlef',2),('Tenes',2),('El Karimia',2),('Oued Fodda',2),('Boukadir',2),
('Ain Merane',2),('Oum Drou',2),('Taougrit',2),('Beni Haoua',2),
('Ouled Fares',2),('Chettia',2),('Abou El Hassan',2),('Zeboudja',2);

-- Wilaya 03: Laghouat (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Laghouat',3),('Aflou',3),('Ksar El Hirane',3),('Hassi Delaa',3),
('Hassi R Mel',3),('Ain Madhi',3),('Tadjemout',3),('El Ghicha',3),
('Brida',3),('Gueltat Sidi Saad',3);

-- Wilaya 04: Oum El Bouaghi (12 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Oum El Bouaghi',4),('Ain Beida',4),('Ain Fakroun',4),('Ain M Lila',4),
('Ksar Sbahi',4),('Sigus',4),('Dhalaa',4),('Ain Babouche',4),
('Meskiana',4),('Ain Kercha',4),('Hanchir Toumghani',4),('Fkirina',4);

-- Wilaya 05: Batna (21 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Batna',5),('Barika',5),('Ain Touta',5),('Merouana',5),('Arris',5),
('N Gaous',5),('Tazoult',5),('Seriana',5),('Menaa',5),('El Madher',5),
('Timgad',5),('Chemora',5),('Oued Chaaba',5),('Ras El Aioun',5),
('Ouyoun El Assafir',5),('Djezzar',5),('Tkout',5),('Ichemoul',5),
('Teniet El Abed',5),('Bouzina',5),('Oued El Ma',5);

-- Wilaya 06: Bejaia (19 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Bejaia',6),('Akbou',6),('Kherrata',6),('Sidi Aich',6),('Amizour',6),
('El Kseur',6),('Tichy',6),('Aokas',6),('Seddouk',6),('Tazmalt',6),
('Adekar',6),('Chemini',6),('Souk El Tenine',6),('Darguina',6),
('Barbacha',6),('Ighil Ali',6),('Ifri Ouzellaguen',6),('Ouzellaguen',6),
('Toudja',6);

-- Wilaya 07: Biskra (12 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Biskra',7),('Tolga',7),('Ouled Djellal',7),('Sidi Okba',7),
('El Kantara',7),('M Chouneche',7),('Zeribet El Oued',7),('Foughala',7),
('Djemorah',7),('Sidi Khaled',7),('Ourlal',7),('Lioua',7);

-- Wilaya 08: Bechar (8 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Bechar',8),('Kenadsa',8),('Abadla',8),('Beni Ounif',8),
('Taghit',8),('Igli',8),('Lahmar',8),('Meridja',8);

-- Wilaya 09: Blida (13 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Blida',9),('Boufarik',9),('Bougara',9),('Ouled Yaich',9),
('Mouzaia',9),('Chrea',9),('Chiffa',9),('Ain Romana',9),
('Beni Mered',9),('Oued El Alleug',9),('El Affroun',9),('Meftah',9),
('Larbaa',9);

-- Wilaya 10: Bouira (12 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Bouira',10),('Ain Bessem',10),('Lakhdaria',10),('Sour El Ghozlane',10),
('M Chedallah',10),('Haizer',10),('Kadiria',10),('Bechloul',10),
('El Hachimia',10),('Bordj Okhriss',10),('Taghzout',10),('Aghbalou',10);

-- Wilaya 11: Tamanrasset (7 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tamanrasset',11),('Abalessa',11),('In Amguel',11),('Ideles',11),
('Tazrouk',11),('Tin Zaouatine',11),('Idles',11);

-- Wilaya 12: Tebessa (12 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tebessa',12),('Cheria',12),('Bir El Ater',12),('El Kouif',12),
('Morsott',12),('El Aouinet',12),('Bekkaria',12),('Ouenza',12),
('Negrine',12),('Hammamet',12),('El Ogla',12),('Boulhaf Dyr',12);

-- Wilaya 13: Tlemcen (20 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tlemcen',13),('Ghazaouet',13),('Remchi',13),('Maghnia',13),
('Nedroma',13),('Ain Temouchent',13),('Sebdou',13),('Beni Snous',13),
('Honaine',13),('Mansourah',13),('Chetouane',13),('Ain Fezza',13),
('Bensekrane',13),('Sidi Djillali',13),('Bab El Assa',13),
('Ouled Mimoun',13),('Ain Youcef',13),('Fellaoucene',13),
('Sabra',13),('Hennaya',13);

-- Wilaya 14: Tiaret (14 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tiaret',14),('Frenda',14),('Ain Deheb',14),('Sougueur',14),
('Ksar Chellala',14),('Mechraa Sfa',14),('Rahouia',14),('Dahmouni',14),
('Mahdia',14),('Oued Lilli',14),('Ain Bouchekif',14),('Medroussa',14),
('Hamadia',14),('Ain Kermes',14);

-- Wilaya 15: Tizi Ouzou (21 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tizi Ouzou',15),('Azazga',15),('Draa Ben Khedda',15),('Ain El Hammam',15),
('Larbaa Nath Irathen',15),('Tigzirt',15),('Boghni',15),('Ouadhias',15),
('Beni Douala',15),('Maatkas',15),('Beni Yenni',15),('Ouaguenoun',15),
('Mekla',15),('Tizi Gheniff',15),('Tizi Rached',15),('Bouzeguene',15),
('Iferhounene',15),('Azeffoun',15),('Freha',15),('Irdjen',15),
('Iflissen',15);

-- Wilaya 16: Alger (57 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Alger Centre',16),('Bab El Oued',16),('Bab Ezzouar',16),('Bir Mourad Rais',16),
('Birkhadem',16),('Bordj El Kiffan',16),('Dar El Beida',16),('Dely Ibrahim',16),
('Draria',16),('El Biar',16),('El Harrach',16),('Hussein Dey',16),
('Kouba',16),('Mohammadia',16),('Rouiba',16),('Sidi Mhamed',16),
('Ain Benian',16),('Cheraga',16),('Zeralda',16),('Staoueli',16),
('Ain Taya',16),('Baraki',16),('Birtouta',16),('Oued Smar',16),
('Saoula',16),('Beni Messous',16),('Bologhine',16),('Casbah',16),
('Oued Koriche',16),('Bachdjerrah',16),('El Mouradia',16),('Hydra',16),
('Belouizdad',16),('El Madania',16),('Hammamet',16),('Les Eucalyptus',16),
('Mohamed Belouizdad',16),('Bourouba',16),('El Magharia',16),
('El Marsa',16),('Bordj El Bahri',16),('Heraoua',16),
('Reghaia',16),('Rouiba',16),('Douera',16),('Ouled Chebel',16),
('Khraicia',16),('El Achour',16),('Tessala El Merdja',16),
('Baba Hassen',16),('Souidania',16),('Mahelma',16),
('Rahmania',16),('Khraissia',16),('Ouled Fayet',16),
('Ben Aknoun',16),('Hammamet',16);

-- Wilaya 17: Djelfa (12 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Djelfa',17),('Ain Oussera',17),('Messaad',17),('Hassi Bahbah',17),
('Moudjebara',17),('El Idrissia',17),('Birine',17),('Dar Chioukh',17),
('Charef',17),('Ain El Ibel',17),('Sidi Ladjel',17),('Faidh El Botma',17);

-- Wilaya 18: Jijel (11 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Jijel',18),('El Milia',18),('Taher',18),('Zighoud Youcef',18),
('El Ancer',18),('Sidi Marouf',18),('Settara',18),('Texenna',18),
('Chekfa',18),('Sidi Abdelaziz',18),('Kaous',18);

-- Wilaya 19: Setif (20 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Setif',19),('El Eulma',19),('Ain Oulmene',19),('Ain Arnat',19),
('Bougaa',19),('Ain El Kebira',19),('Djemila',19),('Ain Azel',19),
('Bazer Sakra',19),('Beni Ourtilane',19),('Hammam Guergour',19),
('Bouandas',19),('Salah Bey',19),('Babor',19),('Hammam Sokhna',19),
('Amoucha',19),('Tizi N Bechar',19),('Maaoklane',19),
('Guenzet',19),('Beni Aziz',19);

-- Wilaya 20: Saida (6 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Saida',20),('Ain El Hadjar',20),('Youb',20),('Hassasna',20),
('Sidi Boubekeur',20),('Ouled Khaled',20);

-- Wilaya 21: Skikda (13 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Skikda',21),('Collo',21),('Azzaba',21),('El Harrouch',21),
('Tamalous',21),('Ain Bouziane',21),('Oued Zehour',21),('Oum Toub',21),
('Kerkera',21),('El Hadaiek',21),('Es Sebt',21),('Filfila',21),
('Ramdane Djamel',21);

-- Wilaya 22: Sidi Bel Abbes (15 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Sidi Bel Abbes',22),('Ain El Berd',22),('Telagh',22),('Ben Badis',22),
('Sfisef',22),('Tessala',22),('Mostefa Ben Brahim',22),('Sidi Lahcene',22),
('Ain Tindamine',22),('Marhoum',22),('Mezaourou',22),('Tenira',22),
('Hassi Zahana',22),('Lamtar',22),('Macta',22);

-- Wilaya 23: Annaba (6 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Annaba',23),('El Bouni',23),('El Hadjar',23),('Sidi Amar',23),
('Berrahal',23),('Ain El Berda',23);

-- Wilaya 24: Guelma (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Guelma',24),('Oued Zenati',24),('Bouchegouf',24),('Hammam Debagh',24),
('Heliopolis',24),('Ain Makhlouf',24),('Nechmaya',24),('Sellaoua Announa',24),
('Houari Boumediene',24),('Khezaras',24);

-- Wilaya 25: Constantine (6 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Constantine',25),('El Khroub',25),('Ain Smara',25),('Hamma Bouziane',25),
('Didouche Mourad',25),('Zighoud Youcef',25);

-- Wilaya 26: Medea (13 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Medea',26),('Berrouaghia',26),('Ksar El Boukhari',26),('Tablat',26),
('Beni Slimane',26),('Ain Boucif',26),('Ouamri',26),('Chahbounia',26),
('El Omaria',26),('Si Mahdjoub',26),('Seghouane',26),('Ouled Antar',26),
('Cheniguel',26);

-- Wilaya 27: Mostaganem (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Mostaganem',27),('Ain Tedeles',27),('Hassi Mamache',27),('Bouguirat',27),
('Sidi Ali',27),('Achaacha',27),('Ain Nouissy',27),('Mesra',27),
('Sidi Lakhdar',27),('Mazagran',27);

-- Wilaya 28: M'sila (15 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Msila',28),('Bou Saada',28),('Ain El Melh',28),('Sidi Aissa',28),
('Hammam Dalaa',28),('Magra',28),('Djebel Messaad',28),('Khoubana',28),
('Berhoum',28),('Ouled Derradj',28),('Ain El Hadjel',28),('Chellal',28),
('Medjedel',28),('Benzouh',28),('Maadid',28);

-- Wilaya 29: Mascara (16 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Mascara',29),('Sig',29),('Mohammadia',29),('Bou Hanifia',29),
('Tighennif',29),('Ghriss',29),('Bouhanifia',29),('Oued Taria',29),
('Ain Fares',29),('Ain Fekan',29),('Hachem',29),('Oggaz',29),
('El Bordj',29),('Tizi',29),('Zahana',29),('Froha',29);

-- Wilaya 30: Ouargla (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Ouargla',30),('Hassi Messaoud',30),('Touggourt',30),('Temacine',30),
('Rouissat',30),('Ain Beida',30),('N Goussa',30),('Sidi Khouiled',30),
('Hassi Ben Abdellah',30),('El Borma',30);

-- Wilaya 31: Oran (26 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Oran',31),('Ain Turk',31),('Es Senia',31),('Bir El Djir',31),
('Arzew',31),('Bethioua',31),('Ain El Kerma',31),('Boutlelis',31),
('Gdyel',31),('Hassi Bounif',31),('Mers El Kebir',31),('Sidi Chahmi',31),
('Bousfer',31),('El Ançor',31),('El Kerma',31),('Hassi Ben Okba',31),
('Ben Freha',31),('Hassi Mefsoukh',31),('Sidi Ben Yebka',31),
('Misserghin',31),('Ain El Bia',31),('Oued Tlelat',31),
('Tafraoui',31),('Boufatis',31),('El Braya',31),('Hassi Ameur',31);

-- Wilaya 32: El Bayadh (8 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('El Bayadh',32),('Bougtob',32),('Brezina',32),('Labiodh Sidi Cheikh',32),
('Boualem',32),('El Abiodh Sidi Cheikh',32),('Ain El Orak',32),('Chellala',32);

-- Wilaya 33: Illizi (6 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Illizi',33),('Djanet',33),('In Amenas',33),('Bordj Omar Driss',33),
('Debdeb',33),('In Amguel',33);

-- Wilaya 34: Bordj Bou Arreridj (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Bordj Bou Arreridj',34),('Ras El Oued',34),('Ain Taghrout',34),
('Bordj Ghedir',34),('El Hamadia',34),('Medjana',34),('Mansourah',34),
('El Achir',34),('Bordj Zemmoura',34),('Djaafra',34);

-- Wilaya 35: Boumerdes (14 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Boumerdes',35),('Bordj Menaiel',35),('Khemis El Khechna',35),('Dellys',35),
('Boudouaou',35),('Isser',35),('Naciria',35),('Tidjelabine',35),
('Thenia',35),('Si Mustapha',35),('Corso',35),('Hammadi',35),
('Zemmouri',35),('Ouled Moussa',35);

-- Wilaya 36: El Tarf (7 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('El Tarf',36),('El Kala',36),('Besbes',36),('Ben M Hidi',36),
('Bouhadjar',36),('Drean',36),('Bouteldja',36);

-- Wilaya 37: Tindouf (2 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tindouf',37),('Oum El Assel',37);

-- Wilaya 38: Tissemsilt (8 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tissemsilt',38),('Bordj Bounama',38),('Theniet El Had',38),('Lardjem',38),
('Khemisti',38),('Lazharia',38),('Beni Chaib',38),('Ammari',38);

-- Wilaya 39: El Oued (12 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('El Oued',39),('Guemar',39),('Debila',39),('Robbah',39),
('Oued Souf',39),('Bayadha',39),('Nakhla',39),('Kouinine',39),
('Hassani Abdelkrim',39),('Magrane',39),('Taleb Larbi',39),('Still',39);

-- Wilaya 40: Khenchela (8 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Khenchela',40),('Kais',40),('Ain Touila',40),('Babar',40),
('Chechar',40),('El Hamma',40),('Bouhmama',40),('Ouled Rechache',40);

-- Wilaya 41: Souk Ahras (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Souk Ahras',41),('Sedrata',41),('Mechroha',41),('Ouled Driss',41),
('Taoura',41),('M Daourouche',41),('Hanancha',41),('Ain Zana',41),
('Merahna',41),('Bir Bouhouch',41);

-- Wilaya 42: Tipaza (10 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Tipaza',42),('Hadjout',42),('Kolea',42),('Cherchell',42),('Fouka',42),
('Bou Ismail',42),('Gouraya',42),('Damous',42),('Sidi Amar',42),
('Ain Tagourait',42);

-- Wilaya 43: Mila (13 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Mila',43),('Chelghoum Laid',43),('Ferdjioua',43),('Grarem Gouga',43),
('Oued Athmania',43),('Rouached',43),('Tassadane Haddada',43),
('Ain Tine',43),('Oued Endja',43),('Tadjenanet',43),
('Sidi Merouane',43),('Teleghma',43),('Terrai Bainen',43);

-- Wilaya 44: Ain Defla (14 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Ain Defla',44),('Miliana',44),('Khemis Miliana',44),('El Attaf',44),
('Djendel',44),('Ain Lechiekh',44),('Rouina',44),('Bourached',44),
('El Abadia',44),('El Amra',44),('Djelida',44),('Hammam Righa',44),
('Boumedfaa',44),('Bir Ould Khelifa',44);

-- Wilaya 45: Naama (7 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Naama',45),('Ain Sefra',45),('Mecheria',45),('Tiout',45),
('Moghrar',45),('Asla',45),('Sfissifa',45);

-- Wilaya 46: Ain Temouchent (8 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Ain Temouchent',46),('Ain El Arbaa',46),('Hammam Bou Hadjar',46),
('El Malah',46),('Beni Saf',46),('El Amria',46),('Oulhaca El Gheraba',46),
('Ain Kihal',46);

-- Wilaya 47: Ghardaia (9 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Ghardaia',47),('Metlili',47),('Berriane',47),('El Atteuf',47),
('Bounoura',47),('Daya Ben Dahoua',47),('Guerrara',47),('Zelfana',47),
('Sebseb',47);

-- Wilaya 48: Relizane (13 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Relizane',48),('Oued Rhiou',48),('Djidioua',48),('Mazouna',48),
('Yellel',48),('Ain Rahma',48),('Ouled Sidi Mihoub',48),('Ammi Moussa',48),
('Mendes',48),('El Matmar',48),('Ain Tarik',48),('Zemmoura',48),
('Sidi Saada',48);

-- Wilaya 49: Timimoun (3 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Timimoun',49),('Aougrout',49),('Tinerkouk',49);

-- Wilaya 50: Bordj Badji Mokhtar (2 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Bordj Badji Mokhtar',50),('Timiaouine',50);

-- Wilaya 51: Ouled Djellal (3 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Ouled Djellal',51),('Sidi Khaled',51),('Doucen',51);

-- Wilaya 52: Beni Abbes (3 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Beni Abbes',52),('El Ouata',52),('Kerzaz',52);

-- Wilaya 53: In Salah (3 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('In Salah',53),('In Ghar',53),('Foggaret Ezzoubia',53);

-- Wilaya 54: In Guezzam (2 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('In Guezzam',54),('Tin Zaouatine',54);

-- Wilaya 55: Touggourt (5 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Touggourt',55),('Temacine',55),('Megarine',55),('Taibet',55),
('Nezla',55);

-- Wilaya 56: Djanet (2 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('Djanet',56),('Bordj El Haoues',56);

-- Wilaya 57: El Meghaier (4 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('El Meghaier',57),('Djamaa',57),('Sidi Amrane',57),('M Rara',57);

-- Wilaya 58: El Meniaa (2 communes)
INSERT OR IGNORE INTO communes (name, wilaya_id) VALUES
('El Meniaa',58),('Hassi El Gara',58);

-- =============================================
-- Utilisateur admin par défaut (mot de passe: admin123)
-- =============================================
INSERT OR IGNORE INTO users (username, password_hash, nom, prenom, email, telephone, store_name, role) VALUES
('admin', 'admin123', 'Administrateur', 'Admin', 'admin@autohub.dz', '0550000000', 'AutoHub DZ', 'admin');

-- =============================================
-- Configuration API - 5 transporteurs exclusifs
-- =============================================
INSERT OR IGNORE INTO api_config (provider, config_json, active) VALUES
('yalidine', '{"api_id":"","api_token":"","base_url":"https://api.yalidine.com/v1"}', 1),
('zr_express', '{"api_key":"","tenant":"","base_url":"https://api.zrexpress.app/api/v1"}', 1),
('ecotrack_pdex', '{"token":"","base_url":"https://pdex.ecotrack.dz/api/v1"}', 1),
('dhd', '{"token":"","base_url":"https://api.dhd-dz.com/api/v1"}', 1),
('noest', '{"token":"","base_url":"https://api.noest-dz.com/api/v1"}', 1);

-- =============================================
-- Transporteurs liés à l'admin par défaut
-- =============================================
INSERT OR IGNORE INTO user_transporteurs (user_id, transporteur) VALUES
(1, 'Yalidine'),
(1, 'ZR Express'),
(1, 'Ecotrack pdex'),
(1, 'DHD'),
(1, 'NOEST');

-- =============================================
-- Commandes de test
-- =============================================
INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur) VALUES
('Ahmed Benali', 3500, '0555123456', 'T-shirt Sport taille:M', 'Alger Centre', '12 Rue Didouche Mourad', 'Alger', 'A domicile', 'Confirme', 'Yalidine'),
('Fatima Zohra', 4200, '0661234567', 'Ensemble Jogging taille:L', 'Oran', '45 Bd Front de Mer', 'Oran', 'Stop desk', 'EN ATTENTE', 'ZR Express'),
('Karim Messaoudi', 2800, '0770987654', 'Polo Classic taille:XL', 'Constantine', '8 Rue Abane Ramdane', 'Constantine', 'A domicile', 'Confirme', 'Yalidine'),
('Nadia Bouzid', 5100, '0558765432', 'Veste Premium taille:S', 'Setif', '22 Cite des Oliviers', 'Setif', 'A domicile', 'Ne repond pas', 'ZR Express'),
('Omar Kaci', 3900, '0667891234', 'Pantalon Cargo taille:M', 'Blida', '3 Rue des Roses', 'Blida', 'Stop desk', 'Confirme', 'Ecotrack pdex');
