// 1. NẠP CÁC THƯ VIỆN CẦN THIẾT
require('dotenv').config(); // Phải đặt ở đầu tiên để đọc được file .env
 
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet'); // ✨ MỚI: Thêm các HTTP header bảo mật cơ bản
const { createStream } = require('rotating-file-stream'); // ✨ MỚI: Xoay vòng file log tự động
const jwt = require('jsonwebtoken'); // ✨ MỚI: Tạo & xác thực JWT cho đăng nhập
const bcrypt = require('bcryptjs'); // ✨ MỚI: Băm mật khẩu, không bao giờ lưu plain text
const rateLimit = require('express-rate-limit'); // ✨ MỚI: Chống spam/DDoS/brute-force
const pool = require('./db'); // Kích hoạt kết nối và khởi tạo DB
 
const app = express();
const PORT = process.env.PORT || 5000; // Lấy PORT từ file .env, nếu không có thì dùng 5000

// ✨ MỚI: Khóa bí mật để ký JWT. BẮT BUỘC đặt JWT_SECRET thật trong .env khi deploy production.
// Nếu thiếu, tạm sinh 1 khóa ngẫu nhiên để app vẫn chạy được khi demo local, nhưng cảnh báo rõ ràng
// vì token cũ sẽ bị vô hiệu mỗi khi restart server (do khóa đổi mỗi lần khởi động lại).
const JWT_SECRET = process.env.JWT_SECRET || (() => {
    console.warn('⚠️  CẢNH BÁO: Chưa cấu hình JWT_SECRET trong .env! Đang dùng khóa ngẫu nhiên tạm thời (đổi mỗi lần restart server). Vui lòng thêm JWT_SECRET vào .env trước khi deploy thật.');
    return require('crypto').randomBytes(32).toString('hex');
})();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
 
// 2. CẤU HÌNH CÁC MIDDLEWARE (Hệ thống xử lý trung gian)
const fs = require('fs');
const path = require('path');

// Hàm helper tự động bắt lỗi của các hàm async và chuyển tiếp sang Middleware trung tâm
const catchAsync = (fn) => {
    return (req, res, next) => {
        fn(req, res, next).catch(next); // Nếu có lỗi, .catch(next) sẽ tự đẩy qua lỗi hệ thống
    };
};

// ✨ MỚI: Middleware xác thực JWT — kiểm tra header "Authorization: Bearer <token>"
// Nếu hợp lệ, gắn thông tin người dùng đã giải mã vào req.user để các route phía sau dùng
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const error = new Error('Bạn cần đăng nhập để thực hiện thao tác này.');
        error.statusCode = 401;
        return next(error);
    }
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET); // { id, name, email, role, iat, exp }
        next();
    } catch (err) {
        const error = new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.');
        error.statusCode = 401;
        next(error);
    }
};

// ✨ MỚI: Middleware chặn quyền — chỉ cho phép role 'admin' đi tiếp (dùng SAU authenticate)
const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        const error = new Error('Bạn không có quyền truy cập chức năng này (yêu cầu quyền quản trị viên).');
        error.statusCode = 403;
        return next(error);
    }
    next();
};

// Hàm helper tự động sinh mã đơn hàng bảo mật dạng: TN-20260711-X97B
const generateOrderCode = () => {
    const now = new Date();
    
    // Lấy ngày, tháng, năm hiện tại (đảm bảo luôn có 2 chữ số cho ngày và tháng)
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    const dateStr = `${year}${month}${day}`; // Kết quả: 20260711
    
    // Tạo chuỗi 4 ký tự ngẫu nhiên bao gồm chữ hoa và số
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomStr = '';
    for (let i = 0; i < 6; i++) {
        randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return `TN-${dateStr}-${randomStr}`; // Trả về dạng: TN-20260711-X97B
};

// ✨ MỚI: Bật Helmet SỚM NHẤT có thể trong chuỗi middleware để áp dụng header bảo mật cho MỌI response
app.use(helmet());

// ✨ MỚI: Đảm bảo thư mục logs/ luôn tồn tại trước khi tạo write stream (tránh lỗi nếu thư mục chưa có)
const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
}

// ✨ MỚI: Tạo stream ghi log có TỰ ĐỘNG XOAY VÒNG mỗi ngày, giữ tối đa 14 file gần nhất,
// và nén (gzip) các file cũ lại để tiết kiệm dung lượng ổ đĩa theo thời gian
const accessLogStream = createStream('access.log', {
    interval: '1d',      // Xoay vòng file mới mỗi ngày
    maxFiles: 14,        // Chỉ giữ lại tối đa 14 file gần nhất (~2 tuần), tự xóa file cũ hơn
    compress: 'gzip',    // Nén file log cũ bằng gzip để tiết kiệm dung lượng
    path: logDirectory
});
 
// Ghi log chi tiết định dạng 'combined' vào file access.log (đã xoay vòng) để lưu trữ
app.use(morgan('combined', { stream: accessLogStream }));
 
// Đồng thời in log định dạng ngắn gọn 'dev' ra màn hình console để dễ theo dõi khi code
app.use(morgan('dev'));
 
// ✨ SỬA: Giới hạn CORS chỉ cho phép các domain được khai báo trong biến môi trường CORS_ORIGIN
// (phân tách nhiều domain bằng dấu phẩy, ví dụ: "https://minishop.com,https://admin.minishop.com")
// Mặc định fallback về cổng dev quen thuộc của Vite (5173) khi chưa cấu hình .env
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map(origin => origin.trim());

app.use(cors({
    origin: (origin, callback) => {
        // Cho phép request không có origin (Postman, curl, app di động, gọi server-to-server...)
        // và các origin nằm trong danh sách cho phép ở .env
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: Origin "${origin}" không được phép truy cập API này.`));
        }
    }
}));
app.use(express.json());

// ✨ MỚI: Giới hạn số request CHUNG cho toàn bộ API, chống spam/DDoS cơ bản
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // Cửa sổ 15 phút
    limit: 300,               // Tối đa 300 request / IP / 15 phút - đủ rộng rãi cho việc duyệt web bình thường
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { status: 'error', message: 'Bạn đã gửi quá nhiều yêu cầu, vui lòng thử lại sau ít phút.' }
});
app.use('/api', generalLimiter);

// ✨ MỚI: Giới hạn NGHIÊM NGẶT hơn riêng cho các hành động nhạy cảm (đặt hàng, đăng nhập, đăng ký)
// để chống spam đơn hàng ảo và chống dò mật khẩu (brute-force login)
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10, // Chỉ 10 lần / IP / 15 phút cho các hành động này
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { status: 'error', message: 'Bạn đã thao tác quá nhiều lần trong thời gian ngắn, vui lòng thử lại sau.' }
});
 
// 3. ĐỊNH TUYẾN HỆ THỐNG (Đưa lên trên Error Handler để Render check thông suốt)
app.get('/', (req, res) => {
    res.status(200).send('🚀 Welcome to E-Commerce Server Core API!');
});

// API Kiểm tra sức khỏe hệ thống (Health Check Endpoint)
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: "UP", 
        timestamp: new Date(), 
        environment: process.env.NODE_ENV || "production", 
        message: "Backend đang chạy tốt!"
    });
});

// 4. VIẾT API: LẤY DANH SÁCH SẢN PHẨM (✨ Nâng cấp thêm PHÂN TRANG và lọc theo category)
app.get('/api/products', catchAsync(async (req, res, next) => {
    // 1. Lấy các tham số lọc từ Query String (?search=...&minPrice=...&maxPrice=...&category=...)
    const { search, minPrice, maxPrice, category } = req.query;

    // ✨ MỚI: Tham số phân trang. Mặc định limit=100 (khá cao) để KHÔNG phá vỡ hành vi hiện tại
    // của Frontend (đang lấy toàn bộ sản phẩm về rồi tự lọc phía client). Trần tối đa 100 để
    // tránh truy vấn quá nặng nếu ai đó cố tình truyền limit cực lớn.
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = 100;
    if (limit > 100) limit = 100;
    const offset = (page - 1) * limit;
    
    // Xây dựng mệnh đề WHERE dùng chung cho cả câu đếm tổng số và câu lấy dữ liệu trang hiện tại
    let whereClause = ' WHERE 1=1';
    let queryParams = [];

    // Nếu có tham số tìm kiếm tên (?search=laptop)
    if (search) {
        queryParams.push(`%${search}%`);
        whereClause += ` AND name ILIKE $${queryParams.length}`; // ILIKE giúp tìm kiếm không phân biệt hoa thường
    }

    // Nếu có tham số lọc giá tối thiểu (?minPrice=1000000)
    if (minPrice) {
        queryParams.push(parseInt(minPrice));
        whereClause += ` AND price >= $${queryParams.length}`;
    }

    // Nếu có tham số lọc giá tối đa (?maxPrice=5000000)
    if (maxPrice) {
        queryParams.push(parseInt(maxPrice));
        whereClause += ` AND price <= $${queryParams.length}`;
    }

    // ✨ MỚI: Nếu có tham số lọc theo danh mục (?category=Thiết Bị Công Nghệ)
    if (category) {
        queryParams.push(category);
        whereClause += ` AND category = $${queryParams.length}`;
    }

    // 2. Đếm tổng số sản phẩm khớp điều kiện lọc (phục vụ tính tổng số trang cho Frontend)
    const countResult = await pool.query(`SELECT COUNT(*) FROM products${whereClause}`, queryParams);
    const totalItems = parseInt(countResult.rows[0].count, 10);

    // 3. Lấy đúng dữ liệu của trang hiện tại (thêm LIMIT/OFFSET vào cuối cùng của params)
    const dataParams = [...queryParams, limit, offset];
    const dataQuery = `SELECT * FROM products${whereClause} ORDER BY id ASC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
    const result = await pool.query(dataQuery, dataParams);

    // 4. Trả dữ liệu dạng JSON kèm thông tin phân trang về cho Frontend
    res.status(200).json({
        status: "success",
        total: totalItems,                          // Tổng số sản phẩm khớp bộ lọc (toàn bộ, không chỉ trang này)
        page,
        limit,
        totalPages: Math.max(Math.ceil(totalItems / limit), 1),
        data: result.rows                           // Mảng sản phẩm CHỈ của trang hiện tại
    });
})); 

// ✨ MỚI 4.0b: API LẤY CHI TIẾT 1 SẢN PHẨM (GET /api/products/:id) - phục vụ trang chi tiết sản phẩm ở Frontend
app.get('/api/products/:id', catchAsync(async (req, res, next) => {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
        const error = new Error('ID sản phẩm trên URL không hợp lệ.');
        error.statusCode = 400;
        return next(error);
    }

    const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);

    if (result.rows.length === 0) {
        const error = new Error(`Không tìm thấy sản phẩm với ID ${productId}.`);
        error.statusCode = 404;
        return next(error);
    }

    res.status(200).json({
        status: "success",
        data: result.rows[0]
    });
}));

// ✨ MỚI 4.1: API LẤY DANH SÁCH THÔNG BÁO (GET /api/notifications)
app.get('/api/notifications', catchAsync(async (req, res, next) => {
    // Cho phép lọc theo loại thông báo nếu Frontend cần (?type=sale | new | order | system)
    const { type } = req.query;

    // Alias cột "description" thành "desc" để khớp đúng tên field Frontend đang đọc (notify.desc)
    let queryText = 'SELECT id, type, title, description AS desc, created_at FROM notifications WHERE 1=1';
    const queryParams = [];

    if (type) {
        queryParams.push(type);
        queryText += ` AND type = $${queryParams.length}`;
    }

    queryText += ' ORDER BY created_at DESC';

    const result = await pool.query(queryText, queryParams);

    res.status(200).json({
        status: "success",
        total: result.rows.length,
        data: result.rows
    });
}));

// ✨ MỚI 4.2: API THÊM SẢN PHẨM MỚI (POST /api/products)
app.post('/api/products', authenticate, requireAdmin, catchAsync(async (req, res, next) => {
    const { name, price, img, description, stock_quantity, category, discount_rate, original_price } = req.body;

    // 🛡️ Validate các trường bắt buộc
    if (!name || typeof name !== 'string' || name.trim() === '') {
        const error = new Error('Tên sản phẩm (name) là bắt buộc và phải là chuỗi ký tự.');
        error.statusCode = 400;
        return next(error);
    }
    if (!Number.isInteger(price) || price <= 0) {
        const error = new Error('Giá sản phẩm (price) phải là số nguyên dương.');
        error.statusCode = 400;
        return next(error);
    }
    // 🛡️ Validate các trường tùy chọn - chỉ kiểm tra nếu người dùng có truyền lên
    if (stock_quantity !== undefined && (!Number.isInteger(stock_quantity) || stock_quantity < 0)) {
        const error = new Error('Số lượng tồn kho (stock_quantity) phải là số nguyên không âm.');
        error.statusCode = 400;
        return next(error);
    }
    if (discount_rate !== undefined && (!Number.isInteger(discount_rate) || discount_rate < 0 || discount_rate > 100)) {
        const error = new Error('Phần trăm giảm giá (discount_rate) phải là số nguyên từ 0 đến 100.');
        error.statusCode = 400;
        return next(error);
    }
    if (original_price !== undefined && original_price !== null && (!Number.isInteger(original_price) || original_price <= 0)) {
        const error = new Error('Giá gốc (original_price) phải là số nguyên dương.');
        error.statusCode = 400;
        return next(error);
    }

    const insertQuery = `
        INSERT INTO products (name, price, img, description, stock_quantity, category, discount_rate, original_price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *;
    `;
    const result = await pool.query(insertQuery, [
        name.trim(),
        price,
        img || null,
        description || null,
        stock_quantity ?? 0,
        category || null,
        discount_rate ?? 0,
        original_price ?? null
    ]);

    res.status(201).json({
        status: "success",
        message: "Đã thêm sản phẩm mới thành công!",
        data: result.rows[0]
    });
}));

// ✨ MỚI 4.3: API CẬP NHẬT SẢN PHẨM (PUT /api/products/:id) - hỗ trợ cập nhật TỪNG PHẦN (partial update)
// Ví dụ: chỉ cần gửi { "category": "...", "discount_rate": 20 } mà không cần gửi lại toàn bộ sản phẩm
app.put('/api/products/:id', authenticate, requireAdmin, catchAsync(async (req, res, next) => {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
        const error = new Error('ID sản phẩm trên URL không hợp lệ.');
        error.statusCode = 400;
        return next(error);
    }

    // Danh sách các trường được phép cập nhật (chặn các trường lạ không thuộc bảng products)
    const allowedFields = ['name', 'price', 'img', 'description', 'stock_quantity', 'category', 'discount_rate', 'original_price'];
    const fieldsToUpdate = Object.keys(req.body).filter(key => allowedFields.includes(key));

    if (fieldsToUpdate.length === 0) {
        const error = new Error('Không có trường hợp lệ nào được gửi lên để cập nhật.');
        error.statusCode = 400;
        return next(error);
    }

    // 🛡️ Validate riêng từng trường dạng số nguyên nếu chúng có mặt trong request
    const intFieldLabels = { price: 'giá (price)', stock_quantity: 'số lượng tồn kho (stock_quantity)', discount_rate: 'phần trăm giảm giá (discount_rate)', original_price: 'giá gốc (original_price)' };
    for (const field of Object.keys(intFieldLabels)) {
        if (fieldsToUpdate.includes(field) && req.body[field] !== null && !Number.isInteger(req.body[field])) {
            const error = new Error(`Trường ${intFieldLabels[field]} phải là số nguyên.`);
            error.statusCode = 400;
            return next(error);
        }
    }
    if (fieldsToUpdate.includes('discount_rate') && (req.body.discount_rate < 0 || req.body.discount_rate > 100)) {
        const error = new Error('Phần trăm giảm giá (discount_rate) phải nằm trong khoảng 0-100.');
        error.statusCode = 400;
        return next(error);
    }

    // Xây dựng câu lệnh UPDATE động, chỉ gồm các cột thực sự được gửi lên trong request
    const setClauses = fieldsToUpdate.map((field, index) => `${field} = $${index + 1}`);
    const values = fieldsToUpdate.map(field => req.body[field]);
    values.push(productId); // Thêm id vào cuối cùng cho mệnh đề WHERE

    const updateQuery = `
        UPDATE products
        SET ${setClauses.join(', ')}
        WHERE id = $${values.length}
        RETURNING *;
    `;

    const result = await pool.query(updateQuery, values);

    if (result.rows.length === 0) {
        const error = new Error(`Không tìm thấy sản phẩm với ID ${productId}.`);
        error.statusCode = 404;
        return next(error);
    }

    res.status(200).json({
        status: "success",
        message: "Đã cập nhật sản phẩm thành công!",
        data: result.rows[0]
    });
}));

// ✨ MỚI 4.4: API XÓA SẢN PHẨM (DELETE /api/products/:id)
app.delete('/api/products/:id', authenticate, requireAdmin, catchAsync(async (req, res, next) => {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
        const error = new Error('ID sản phẩm trên URL không hợp lệ.');
        error.statusCode = 400;
        return next(error);
    }

    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id, name', [productId]);

    if (result.rows.length === 0) {
        const error = new Error(`Không tìm thấy sản phẩm với ID ${productId} để xóa.`);
        error.statusCode = 404;
        return next(error);
    }

    res.status(200).json({
        status: "success",
        message: `Đã xóa sản phẩm "${result.rows[0].name}" thành công!`,
        data: result.rows[0]
    });
}));
 
// 5. VIẾT API: XỬ LÝ ĐẶT HÀNG & TRỪ KHO TỰ ĐỘNG (POST /api/orders)
app.post('/api/orders', strictLimiter, catchAsync(async (req, res, next) => {
    let client; // Đưa biến client ra ngoài phạm vi để khối finally luôn bắt được và giải phóng kết nối
 
    try {
        // 🛡️ LỚP PHÒNG THỦ 1: Chống crash lỗi 500 HTML khi gói tin req.body trống rỗng/mất kết nối dưới tải nặng
        if (!req.body || Object.keys(req.body).length === 0) {
            const error = new Error("Không nhận được dữ liệu đơn hàng. Vui lòng kiểm tra lại cấu hình định dạng body JSON!");
            error.statusCode = 400;
            return next(error);
        }

        // Tiếp nhận Request body từ Frontend một cách an toàn bên trong khối xử lý lỗi try...catch
        const { customer_name, items } = req.body;
 
        // 🛡️ LỚP PHÒNG THỦ 2: Kiểm tra dữ liệu đầu vào cơ bản (Validation)
        if (!customer_name || !items || !Array.isArray(items) || items.length === 0) {
            const error = new Error("Thông tin đơn hàng không hợp lệ. Vui lòng cung cấp tên và danh sách sản phẩm!");
            error.statusCode = 400;
            return next(error);
        }
 
        // Sau khi kiểm tra dữ liệu đầu vào thành công mới mượn cổng kết nối kết nối từ Pool
        client = await pool.connect();
 
        // BƯỚC 4.0: Khởi động Giao dịch (Transaction)
        await client.query('BEGIN');
        console.log(`\n=================== 🛒 KHỞI TẠO TRANSACTION ĐƠN HÀNG [Khách: ${customer_name}] ===================`);
 
        let totalPrice = 0;
        const orderSummary = [];
 
        // Duyệt qua từng sản phẩm trong giỏ hàng để kiểm tra kho và tính tiền
        for (const item of items) {
            const { product_id, quantity } = item;
 
            // ✨ Kiểm tra chặt chẽ: phải là số nguyên hợp lệ (tránh lọt qua chuỗi như "abc", số âm, số thập phân)
            if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity <= 0) {
                throw new Error(`Sản phẩm hoặc số lượng mua không hợp lệ.`);
            }
 
            // BƯỚC 4.1: KIỂM TRA KHO VÀ LOCK DÒNG (FOR UPDATE)
            // Ngăn chặn Race Condition: Nếu có request khác định sửa sản phẩm này, chúng phải xếp hàng đợi COMMIT.
            const productCheck = await client.query(
                'SELECT id, name, price, stock_quantity FROM products WHERE id = $1 FOR UPDATE',
                [product_id]
            );
 
            if (productCheck.rows.length === 0) {
                throw new Error(`Sản phẩm với ID ${product_id} không tồn tại trên hệ thống.`);
            }
 
            const product = productCheck.rows[0];
 
            // BƯỚC 4.2: ĐỐI CHIẾU SỐ LƯỢNG TỒN KHO GIẢ LẬP
            if (product.stock_quantity < quantity) {
                throw new Error(`Sản phẩm [${product.name}] đã hết hàng hoặc không đủ số lượng (Hiện còn: ${product.stock_quantity}, Bạn muốn mua: ${quantity}).`);
            }
 
            // BƯỚC 4.3: TIẾN HÀNH TRỪ KHO TRONG TRANSACTION
            await client.query(
                'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                [quantity, product_id]
            );
            console.log(`📦 [LOG TRỪ KHO] Sản phẩm: ${product.name} | Đã trừ: ${quantity} | Còn lại: ${product.stock_quantity - quantity}`);
 
            // Tính toán tổng tiền ở Backend (Tuyệt đối không lấy giá tiền từ Frontend truyền lên để tránh bị hack)
            const itemTotalPrice = product.price * quantity;
            totalPrice += itemTotalPrice;
 
            // Lưu thông tin tóm tắt để nạp vào bảng hóa đơn
            orderSummary.push({
                product_id: product.id,
                product_name: product.name,
                price: product.price,
                quantity: quantity,
                subtotal: itemTotalPrice
            });
        }
 
        // BƯỚC 4.4: TẠO ĐƠN HÀNG LƯU VÀO DATABASE
        
        // 1. Sinh mã đơn hàng ngẫu nhiên theo ngày tháng cho khách hàng này
        const orderCode = generateOrderCode(); 

        // 2. Cập nhật câu lệnh INSERT bổ sung cột order_code
        const insertOrderQuery = `
            INSERT INTO orders (order_code, customer_name, total_price, items) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, order_code, customer_name, total_price, created_at;
        `; 
        
        const orderResult = await client.query(insertOrderQuery, [
            orderCode,          // $1
            customer_name,      // $2
            totalPrice,         // $3
            JSON.stringify(orderSummary) // $4
        ]);

        // ✨ MỚI: Tự động tạo 1 thông báo loại 'order' mỗi khi có đơn hàng mới đặt thành công
        await client.query(
            `INSERT INTO notifications (type, title, description) VALUES ($1, $2, $3)`,
            [
                'order',
                'Đơn hàng mới vừa được đặt',
                `Khách hàng ${customer_name} vừa đặt đơn hàng ${orderCode} trị giá ${totalPrice.toLocaleString('vi-VN')}đ.`
            ]
        );
  
        // CHỐT GIAO DỊCH: Xác nhận lưu tất cả thay đổi vĩnh viễn xuống DB
        await client.query('COMMIT');
        console.log(`✅ [TRANSACTION SUCCESS] Đơn hàng ${orderResult.rows[0].order_code} (ID: #${orderResult.rows[0].id}) đã chốt thành công.`);
        console.log(`========================================================================================\n`);
 
        // Trả về kết quả cho Frontend (Frontend từ nay sẽ dùng order_code để hiển thị cho khách)
        res.status(201).json({
            status: "success",
            message: "Đặt hàng thành công và hệ thống đã cập nhật số lượng tồn kho giả lập!",
            order: orderResult.rows[0] // Trả ra đầy đủ id chạy ngầm và order_code hiển thị
        });
 
    } catch (err) {
        // HỦY GIAO DỊCH (ROLLBACK): Chỉ thực hiện hủy khi cổng kết nối client đã được mượn thành công
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error(`❌ [TRANSACTION ROLLBACK] Giao dịch thất bại. Lý do:`, err.message);
        console.log(`========================================================================================\n`);
 
        // Phân tách mã lỗi nghiệp vụ hoặc lỗi crash hệ thống
        const isValidationError = err.message.includes('không tồn tại') || err.message.includes('không đủ số lượng') || err.message.includes('không hợp lệ');
        err.statusCode = isValidationError ? 400 : 500;
        
        // Đẩy lỗi sang Trạm xử lý tập trung điều phối phản hồi JSON thay vì trả về thô tại đây
        next(err);
 
    } finally {
        // ⚠️ ĐIỀU KIỆN TIÊN QUYẾT: Giải phóng kết nối trả lại cho Pool quản lý, tránh rò rỉ (Connection Leak)
        if (client) {
            client.release();
        }
    }
}));


// 5.1 ✨ MỚI: API DANH SÁCH ĐƠN HÀNG (GET /api/orders) - dùng cho trang quản trị, YÊU CẦU quyền admin
// Hỗ trợ lọc theo trạng thái (?status=pending|confirmed|shipping|delivered|cancelled) + phân trang
const ORDER_STATUSES = ['pending', 'confirmed', 'shipping', 'delivered', 'cancelled'];

app.get('/api/orders', authenticate, requireAdmin, catchAsync(async (req, res, next) => {
    const { status } = req.query;
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    const offset = (page - 1) * limit;

    let whereClause = ' WHERE 1=1';
    const queryParams = [];
    if (status) {
        if (!ORDER_STATUSES.includes(status)) {
            const error = new Error(`Trạng thái không hợp lệ. Chỉ chấp nhận: ${ORDER_STATUSES.join(', ')}.`);
            error.statusCode = 400;
            return next(error);
        }
        queryParams.push(status);
        whereClause += ` AND status = $${queryParams.length}`;
    }

    const countResult = await pool.query(`SELECT COUNT(*) FROM orders${whereClause}`, queryParams);
    const totalItems = parseInt(countResult.rows[0].count, 10);

    const dataParams = [...queryParams, limit, offset];
    const dataQuery = `SELECT * FROM orders${whereClause} ORDER BY created_at DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
    const result = await pool.query(dataQuery, dataParams);

    res.status(200).json({
        status: "success",
        total: totalItems,
        page,
        limit,
        totalPages: Math.max(Math.ceil(totalItems / limit), 1),
        data: result.rows
    });
}));

// 5.2 ✨ MỚI: API TRA CỨU 1 ĐƠN HÀNG THEO MÃ ĐƠN (GET /api/orders/:code)
// Công khai (không cần đăng nhập) - khách hàng dùng mã đơn nhận được sau khi đặt hàng để tự tra cứu
app.get('/api/orders/:code', catchAsync(async (req, res, next) => {
    const { code } = req.params;
    const result = await pool.query('SELECT * FROM orders WHERE order_code = $1', [code]);

    if (result.rows.length === 0) {
        const error = new Error(`Không tìm thấy đơn hàng với mã "${code}".`);
        error.statusCode = 404;
        return next(error);
    }

    res.status(200).json({ status: "success", data: result.rows[0] });
}));

// 5.3 ✨ MỚI: API CẬP NHẬT TRẠNG THÁI ĐƠN HÀNG (PATCH /api/orders/:code/status) - YÊU CẦU quyền admin
app.patch('/api/orders/:code/status', authenticate, requireAdmin, catchAsync(async (req, res, next) => {
    const { code } = req.params;
    const { status } = req.body;

    if (!status || !ORDER_STATUSES.includes(status)) {
        const error = new Error(`Trạng thái không hợp lệ. Chỉ chấp nhận: ${ORDER_STATUSES.join(', ')}.`);
        error.statusCode = 400;
        return next(error);
    }

    const result = await pool.query(
        'UPDATE orders SET status = $1 WHERE order_code = $2 RETURNING *',
        [status, code]
    );

    if (result.rows.length === 0) {
        const error = new Error(`Không tìm thấy đơn hàng với mã "${code}".`);
        error.statusCode = 404;
        return next(error);
    }

    res.status(200).json({
        status: "success",
        message: `Đã cập nhật trạng thái đơn hàng ${code} thành "${status}".`,
        data: result.rows[0]
    });
}));

// 5.4 ✨ MỚI: NHÓM API XÁC THỰC NGƯỜI DÙNG (/api/auth/...)

// API ĐĂNG KÝ TÀI KHOẢN (POST /api/auth/register)
app.post('/api/auth/register', strictLimiter, catchAsync(async (req, res, next) => {
    const { name, email, password } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
        const error = new Error('Họ tên là bắt buộc.');
        error.statusCode = 400;
        return next(error);
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !emailRegex.test(email)) {
        const error = new Error('Email không hợp lệ.');
        error.statusCode = 400;
        return next(error);
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
        const error = new Error('Mật khẩu phải có ít nhất 6 ký tự.');
        error.statusCode = 400;
        return next(error);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
        const error = new Error('Email này đã được đăng ký. Vui lòng đăng nhập hoặc dùng email khác.');
        error.statusCode = 409;
        return next(error);
    }

    // Băm mật khẩu với cost factor 10 (mức khuyến nghị phổ biến, cân bằng giữa an toàn và tốc độ)
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
        `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, role, created_at`,
        [name.trim(), normalizedEmail, passwordHash]
    );
    const user = result.rows[0];

    const token = jwt.sign(
        { id: user.id, name: user.name, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
        status: "success",
        message: "Đăng ký tài khoản thành công!",
        token,
        user
    });
}));

// API ĐĂNG NHẬP (POST /api/auth/login)
app.post('/api/auth/login', strictLimiter, catchAsync(async (req, res, next) => {
    const { email, password } = req.body;

    if (!email || !password) {
        const error = new Error('Vui lòng nhập đầy đủ email và mật khẩu.');
        error.statusCode = 400;
        return next(error);
    }

    // Thông báo lỗi CHUNG CHUNG dù sai email hay sai mật khẩu, để tránh lộ thông tin
    // cho kẻ tấn công dò xem email nào đã đăng ký trong hệ thống (user enumeration)
    const invalidCredentials = () => {
        const error = new Error('Email hoặc mật khẩu không chính xác.');
        error.statusCode = 401;
        return error;
    };

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (result.rows.length === 0) {
        return next(invalidCredentials());
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
        return next(invalidCredentials());
    }

    const token = jwt.sign(
        { id: user.id, name: user.name, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(200).json({
        status: "success",
        message: "Đăng nhập thành công!",
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, created_at: user.created_at }
    });
}));

// API LẤY THÔNG TIN TÀI KHOẢN ĐANG ĐĂNG NHẬP (GET /api/auth/me) - cần token hợp lệ
app.get('/api/auth/me', authenticate, catchAsync(async (req, res, next) => {
    const result = await pool.query('SELECT id, name, email, role, created_at FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
        const error = new Error('Không tìm thấy tài khoản.');
        error.statusCode = 404;
        return next(error);
    }
    res.status(200).json({ status: "success", user: result.rows[0] });
}));


// 6. TRẠM XỬ LÝ LỖI TẬP TRUNG (Global Error Handler - Bắt buộc đặt ở đáy tệp)
app.use((err, req, res, next) => {
    // 1. Ghi nhận log lỗi vào console để lập trình viên theo dõi dưới máy local
    console.error('💥 LỖI HỆ THỐNG:', err.stack);

    // 2. Xác định mã trạng thái HTTP (mặc định là 500 nếu lỗi không xác định)
    // ✨ Trường hợp riêng: body JSON gửi lên bị sai cú pháp (express.json() ném lỗi type 'entity.parse.failed')
    if (err.type === 'entity.parse.failed') {
        err.statusCode = 400;
        err.message = 'Dữ liệu JSON gửi lên bị sai định dạng. Vui lòng kiểm tra lại cú pháp!';
    }
    const statusCode = err.statusCode || 500;
    
    // 3. Trả về phản hồi JSON chuẩn hóa cho Frontend
    res.status(statusCode).json({
        success: false,
        status: statusCode === 500 ? 'fail' : 'error',
        message: err.message || 'Hệ thống xảy ra sự cố nội bộ!',
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }) // Chỉ hiển thị stack trace khi không phải môi trường production
    });
});

// 7. MỞ CỔNG LẮNG NGHE REQUEST
const server = app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`🚀 Server đang chạy thành công tại cổng: ${PORT}`);
    console.log(`🌐 API sức khỏe hệ thống: http://localhost:${PORT}/api/health`);
    console.log(`=============================================`);
});

// 8. GRACEFUL SHUTDOWN: Đóng kết nối DB an toàn khi nhận tín hiệu tắt server
// (Render gửi SIGTERM mỗi lần deploy lại hoặc scale server, cần đóng pool tránh rò rỉ kết nối)
const shutdown = async (signal) => {
    console.log(`\n🛑 Nhận tín hiệu ${signal}. Đang đóng server an toàn...`);
    server.close(async () => {
        await pool.end();
        console.log('🔌 Đã đóng toàn bộ kết nối Database. Tạm biệt!');
        process.exit(0);
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));