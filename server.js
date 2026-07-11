// 1. NẠP CÁC THƯ VIỆN CẦN THIẾT
require('dotenv').config(); // Phải đặt ở đầu tiên để đọc được file .env
 
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const pool = require('./db'); // Kích hoạt kết nối và khởi tạo DB
 
const app = express();
const PORT = process.env.PORT || 5000; // Lấy PORT từ file .env, nếu không có thì dùng 5000
 
// 2. CẤU HÌNH CÁC MIDDLEWARE (Hệ thống xử lý trung gian)
const fs = require('fs');
const path = require('path');

// Hàm helper tự động bắt lỗi của các hàm async và chuyển tiếp sang Middleware trung tâm
const catchAsync = (fn) => {
    return (req, res, next) => {
        fn(req, res, next).catch(next); // Nếu có lỗi, .catch(next) sẽ tự đẩy qua lỗi hệ thống
    };
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
// Tạo một luồng ghi file (Write Stream) ở chế độ append (ghi nối tiếp)
const accessLogStream = fs.createWriteStream(
    path.join(__dirname, 'access.log'), 
    { flags: 'a' }
);
 
// Ghi log chi tiết định dạng 'combined' vào file access.log để lưu trữ
app.use(morgan('combined', { stream: accessLogStream }));
 
// Đồng thời in log định dạng ngắn gọn 'dev' ra màn hình console để dễ theo dõi khi code
app.use(morgan('dev'));
 
// Thêm màng lọc CORS và bộ phân giải dữ liệu JSON từ Client gửi lên
app.use(cors());
app.use(express.json());
 
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

// 4. VIẾT API: LẤY DANH SÁCH SẢN PHẨM (Nâng cấp tích hợp catchAsync xử lý lỗi tập trung)
app.get('/api/products', catchAsync(async (req, res, next) => {
    // 1. Lấy các tham số lọc từ Query String (?search=...&minPrice=...&maxPrice=...)
    const { search, minPrice, maxPrice } = req.query;
    
    let queryText = 'SELECT * FROM products WHERE 1=1';
    let queryParams = [];
    let paramIndex = 1;

    // Nếu có tham số tìm kiếm tên (?search=laptop)
    if (search) {
        queryText += ` AND name ILIKE $${paramIndex}`; // ILIKE giúp tìm kiếm không phân biệt hoa thường
        queryParams.push(`%${search}%`);
        paramIndex++;
    }

    // Nếu có tham số lọc giá tối thiểu (?minPrice=1000000)
    if (minPrice) {
        queryText += ` AND price >= $${paramIndex}`;
        queryParams.push(parseInt(minPrice));
        paramIndex++;
    }

    // Nếu có tham số lọc giá tối đa (?maxPrice=5000000)
    if (maxPrice) {
        queryText += ` AND price <= $${paramIndex}`;
        queryParams.push(parseInt(maxPrice));
        paramIndex++;
    }

    // Luôn sắp xếp theo ID tăng dần để đảm bảo giao diện hiển thị đồng nhất
    queryText += ' ORDER BY id ASC';

    // 2. Thực hiện truy vấn vào Database
    const result = await pool.query(queryText, queryParams);
    
    // 3. Kiểm tra nếu kết quả trống (Database trống hoặc không tìm thấy sản phẩm phù hợp)
    if (result.rows.length === 0) {
        return res.status(200).json({
            status: "success",
            message: "Hiện tại chưa có sản phẩm nào trong cửa hàng.",
            data: []
        });
    }

    // 4. Trả dữ liệu dạng JSON về cho Frontend
    res.status(200).json({
        status: "success",
        total: result.rows.length,
        data: result.rows // Mảng chứa danh sách các sản phẩm
    });
})); 
 
// 5. VIẾT API: XỬ LÝ ĐẶT HÀNG & TRỪ KHO TỰ ĐỘNG (POST /api/orders)
app.post('/api/orders', catchAsync(async (req, res, next) => {
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
 
            if (!product_id || !quantity || quantity <= 0) {
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
 
        // CHỐT GIAO DỊCH: Xác nhận lưu tất cả thay đổi vĩnh viễn xuống DB
        await client.query('COMMIT');
        console.log(`✅ [TRANSACTION SUCCESS] Đơn hàng #${orderResult.rows[0].id} đã chốt thành công.`);
        console.log(`========================================================================================\n`);
 
        // Trả về kết quả thành công dưới dạng JSON đồng nhất cho Frontend hiển thị hóa đơn
        res.status(201).json({
            status: "success",
            message: "Đặt hàng thành công và hệ thống đã cập nhật số lượng tồn kho giả lập!",
            order: orderResult.rows[0]
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


// 6. TRẠM XỬ LÝ LỖI TẬP TRUNG (Global Error Handler - Bắt buộc đặt ở đáy tệp)
app.use((err, req, res, next) => {
    // 1. Ghi nhận log lỗi vào console để lập trình viên theo dõi dưới máy local
    console.error('💥 LỖI HỆ THỐNG:', err.stack);

    // 2. Xác định mã trạng thái HTTP (mặc định là 500 nếu lỗi không xác định)
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
app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`🚀 Server đang chạy thành công tại cổng: ${PORT}`);
    console.log(`🌐 API sức khỏe hệ thống: http://localhost:${PORT}/api/health`);
    console.log(`=============================================`);
});